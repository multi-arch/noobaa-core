/* Copyright (C) 2016 NooBaa */
'use strict';

const _ = require('lodash');
const os = require('os');
const util = require('util');
const assert = require('assert');
const stream = require('stream');
const crypto = require('crypto');

const P = require('../util/promise');
const dbg = require('../util/debug_module')(__filename);
const config = require('../../config');
const Pipeline = require('../util/pipeline');
const LRUCache = require('../util/lru_cache');
const nb_native = require('../util/nb_native');
const Semaphore = require('../util/semaphore');
const size_utils = require('../util/size_utils');
const ChunkCoder = require('../util/chunk_coder');
const range_utils = require('../util/range_utils');
const buffer_utils = require('../util/buffer_utils');
const ChunkSplitter = require('../util/chunk_splitter');
const KeysSemaphore = require('../util/keys_semaphore');
const CoalesceStream = require('../util/coalesce_stream');
const ChunkedContentDecoder = require('../util/chunked_content_decoder');
const block_store_client = require('../agent/block_store_services/block_store_client').instance();

const { MapClient } = require('./map_client');
const { ChunkAPI } = require('./map_api_types');
const { RpcError, RPC_BUFFERS } = require('../rpc');

// dbg.set_level(5, 'core');
/**
 * @typedef {Object} UploadParams
 * @property {Object} client
 * @property {string} obj_id
 * @property {string} bucket
 * @property {string} key
 * @property {string} content_type
 * @property {number} size
 * @property {string} md5_b64
 * @property {string} sha256_b64
 * @property {Object} xattr
 * @property {Object} md_conditions
 * @property {Object} copy_source
 * @property {string} [tier_id]
 * @property {string} [bucket_id]
 * @property {string} [multipart_id]
 * @property {boolean} [chunked_content]
 * @property {stream.Readable} [source_stream]
 * @property {Object} [desc]
 * @property {number} [start]
 * @property {number} [seq]
 * @property {Object} [chunk_split_config]
 * @property {Object} [chunk_coder_config]
 */

class ObjectReadable extends stream.Readable {

    /**
     * 
     * @param {Object} params
     * @param {number} [params.watermark]
     * @param {number} [params.start]
     * @param {number} [params.end]
     * @param {(size:number) => void} read
     */
    constructor(params, read) {
        super({
            // highWaterMark Number - The maximum number of bytes to store
            // in the internal buffer before ceasing to read
            // from the underlying resource. Default=16kb
            highWaterMark: params.watermark || config.IO_OBJECT_RANGE_ALIGN,
            // encoding String - If specified, then buffers will be decoded to strings
            // using the specified encoding. Default=null
            encoding: null,
            // objectMode Boolean - Whether this stream should behave as a stream of objects.
            // Meaning that stream.read(n) returns a single value
            // instead of a Buffer of size n. Default=false
            objectMode: false,
        });
        this.pos = Number(params.start) || 0;
        this.end = _.isUndefined(params.end) ? Infinity : Number(params.end);
        this.pending = [];
        this._read = read;
    }

    // close() is setting a flag to enforce immediate close
    // and avoid more reads made by buffering
    // which can cause many MB of unneeded reads
    close() {
        this.closed = true;
    }
}

/**
 *
 * OBJECT IO
 *
 * the object io is a "heavy" instance with data caches.
 *
 * extends object_api which is plain REST api with logic to provide access
 * to remote object storage, and does the necessary distributed of io.
 * the client functions usually have the signature function(params), and return a promise.
 *
 * this is the client side (web currently) that sends the commands
 * defined in object_api to the web server.
 *
 */
class ObjectIO {

    /**
     * 
     * @param {nb.LocationInfo} [location_info]
     */
    constructor(location_info) {
        this._last_io_bottleneck_report = 0;
        this.location_info = location_info;

        this._block_read_sem_global = new Semaphore(config.IO_READ_CONCURRENCY_GLOBAL);
        this._block_read_sem_agent = new KeysSemaphore(config.IO_READ_CONCURRENCY_AGENT);
        this._io_buffers_sem = new Semaphore(config.IO_SEMAPHORE_CAP, {
            timeout: config.IO_STREAM_SEMAPHORE_TIMEOUT,
            timeout_error_code: 'OBJECT_IO_STREAM_ITEM_TIMEOUT'
        });
        this._init_read_cache();

        dbg.log0('ObjectIO Configurations:', util.inspect({
            location_info,
            totalmem: os.totalmem(),
            ENDPOINT_FORKS_COUNT: config.ENDPOINT_FORKS_COUNT,
            IO_SEMAPHORE_CAP: config.IO_SEMAPHORE_CAP
        }));

    }

    set_verification_mode() {
        this._verification_mode = true;
    }

    clear_verification_mode() {
        this._verification_mode = false;
    }



    ////////////////////////////////////////////////////////////////////////////
    // UPLOAD FLOW /////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////

    /**
     *
     * upload_object
     *
     * upload the entire source_stream as a new object
     *
     * @param {UploadParams} params
     */
    async upload_object(params) {
        const create_params = _.pick(params,
            'bucket',
            'key',
            'content_type',
            'size',
            'md5_b64',
            'sha256_b64',
            'xattr',
            'tagging',
        );
        const complete_params = _.pick(params,
            'obj_id',
            'bucket',
            'key',
            'md_conditions',
        );
        try {
            dbg.log0('upload_object: start upload', create_params);
            const create_reply = await params.client.object.create_object_upload(create_params);
            params.obj_id = create_reply.obj_id;
            params.tier_id = create_reply.tier_id;
            params.bucket_id = create_reply.bucket_id;
            params.chunk_split_config = create_reply.chunk_split_config;
            params.chunk_coder_config = create_reply.chunk_coder_config;
            complete_params.obj_id = create_reply.obj_id;
            if (params.copy_source) {
                await this._upload_copy(params, complete_params);
            } else {
                await this._upload_stream(params, complete_params);
            }
            dbg.log0('upload_object: complete upload', complete_params);
            const complete_result = await params.client.object.complete_object_upload(complete_params);
            if (params.copy_source) {
                complete_result.copy_source = params.copy_source;
            }
            return complete_result;
        } catch (err) {
            dbg.warn('upload_object: failed upload', complete_params, err);
            if (params.obj_id) {
                try {
                    await params.client.object.abort_object_upload(_.pick(params, 'bucket', 'key', 'obj_id'));
                    dbg.log0('upload_object: aborted object upload', complete_params);
                } catch (err2) {
                    dbg.warn('upload_object: Failed to abort object upload', complete_params, err2);
                }
            }
            throw err; // throw the original error
        }
    }

    /**
     * @param {UploadParams} params
     */
    async upload_multipart(params) {
        const create_params = _.pick(params,
            'obj_id',
            'bucket',
            'key',
            'num',
            'size',
            'md5_b64',
            'sha256_b64'
        );
        const complete_params = _.pick(params,
            'multipart_id',
            'obj_id',
            'bucket',
            'key',
            'num',
        );
        try {
            dbg.log0('upload_multipart: start upload', complete_params);
            const multipart_reply = await params.client.object.create_multipart(create_params);
            params.tier_id = multipart_reply.tier_id;
            params.bucket_id = multipart_reply.bucket_id;
            params.multipart_id = multipart_reply.multipart_id;
            params.chunk_split_config = multipart_reply.chunk_split_config;
            params.chunk_coder_config = multipart_reply.chunk_coder_config;
            complete_params.multipart_id = multipart_reply.multipart_id;
            if (params.copy_source) {
                await this._upload_copy(params, complete_params);
            } else {
                await this._upload_stream(params, complete_params);
            }
            dbg.log0('upload_multipart: complete upload', complete_params);
            return params.client.object.complete_multipart(complete_params);
        } catch (err) {
            dbg.warn('upload_multipart: failed', complete_params, err);
            // we leave the cleanup of failed multiparts to complete_object_upload or abort_object_upload
            throw err;
        }
    }

    /**
     * @param {UploadParams} params
     * @param {Object} complete_params
     */
    async _upload_copy(params, complete_params) {
        const { obj_id, bucket, key, version_id, ranges } = params.copy_source;
        if (bucket !== params.bucket || ranges) {
            if (ranges) {
                params.source_stream = this.read_object_stream({
                    client: params.client,
                    obj_id,
                    bucket,
                    key,
                    version_id,
                    start: ranges[0].start,
                    end: ranges[0].end,
                });
            } else {
                params.source_stream = this.read_object_stream({
                    client: params.client,
                    obj_id,
                    bucket,
                    key,
                    version_id,
                });
            }
            return this._upload_stream(params, complete_params);
        }

        // copy mappings
        const { object_md, parts } = await params.client.object.read_object_mappings({
            obj_id,
            bucket,
            key,
            version_id,
        });
        complete_params.size = object_md.size;
        complete_params.num_parts = parts.length;
        complete_params.md5_b64 = object_md.md5_b64;
        complete_params.sha256_b64 = object_md.sha256_b64;
        complete_params.etag = object_md.etag; // preserve source etag
        return params.client.object.finalize_object_parts({
            obj_id: params.obj_id,
            bucket: params.bucket,
            key: params.key,
            // sending part.chunk_id so no need for part.chunk info
            parts: _.map(parts, p => {
                const new_part = _.omit(p, 'chunk', 'multipart_id');
                new_part.multipart_id = complete_params.multipart_id;
                return new_part;
            }),
        });
    }


    /**
     *
     * _upload_stream
     *
     * upload the source_stream parts to object in upload mode
     * by reading large portions from the stream and call _upload_chunks()
     *
     * @param {UploadParams} params
     * @param {Object} complete_params
     */
    async _upload_stream(params, complete_params) {
        try {
            const res = await this._io_buffers_sem.surround_count(
                _get_io_semaphore_size(params.size),
                () => this._upload_stream_internal(params, complete_params)
            );
            return res;
        } catch (err) {
            this._handle_semaphore_errors(params.client, err);
            dbg.error('_upload_stream error', err, err.stack);
            throw err;
        }
    }

    /**
     * @param {UploadParams} params
     * @param {Object} complete_params
     */
    async _upload_stream_internal(params, complete_params) {

        params.desc = _.pick(params, 'obj_id', 'num', 'bucket', 'key');
        dbg.log0('UPLOAD:', params.desc, 'streaming to', params.bucket, params.key);

        // start and seq are set to zero even for multiparts and will be fixed
        // when multiparts are combined to object in complete_object_upload
        params.start = 0;
        params.seq = 0;

        params.source_stream._readableState.highWaterMark = size_utils.MEGABYTE;
        // Commeneted out due to changes in node.js v10
        // stream: 'readable' have precedence over flowing
        // https://github.com/nodejs/node/commit/cf5f9867ff
        // params.source_stream.on('readable',
        //            () => dbg.log0('UPLOAD: readable', params.desc, 'streaming to', params.bucket, params.key)
        // );

        complete_params.size = 0;
        complete_params.num_parts = 0;

        // The splitter transformer is responsible for splitting the stream into chunks
        // and also calculating the md5/sha256 of the entire stream as needed for the protocol.
        const splitter = new ChunkSplitter({
            watermark: 100,
            calc_md5: true,
            calc_sha256: Boolean(params.sha256_b64),
            chunk_split_config: params.chunk_split_config,
        });

        // The coder transformer is responsible for digest & compress & encrypt & erasure coding
        const coder = new ChunkCoder({
            watermark: 20,
            concurrency: 20,
            coder: 'enc',
            chunk_coder_config: params.chunk_coder_config,
        });

        const coalescer = new CoalesceStream({
            objectMode: true,
            max_length: 20,
            max_wait_ms: 10,
        });

        // The uploader transformer takes chunks after processed by the coder and uploads them
        // by doing allocate(md) + write(data) + finalize(md).
        const uploader = new stream.Transform({
            objectMode: true,
            allowHalfOpen: false,
            highWaterMark: 1,
            transform: (chunks, encoding, callback) =>
                this._upload_chunks(params, complete_params, chunks, callback)
        });

        const pipeline = new Pipeline(params.source_stream);

        if (params.chunked_content) pipeline.pipe(new ChunkedContentDecoder());
        pipeline.pipe(splitter);
        pipeline.pipe(coder);
        pipeline.pipe(coalescer);
        pipeline.pipe(uploader);
        await pipeline.promise();

        complete_params.md5_b64 = splitter.md5.toString('base64');
        if (splitter.sha256) complete_params.sha256_b64 = splitter.sha256.toString('base64');
    }


    /**
     *
     * _upload_chunks
     *
     * upload parts to object in upload mode
     * where data is buffer or array of buffers in memory.
     * @param {Object} params
     * @param {Object} complete_params
     * @param {nb.ChunkInfo[]} chunks
     * @param {(err?: Error) => void} callback
     */
    async _upload_chunks(params, complete_params, chunks, callback) {
        try {
            params.range = {
                start: params.start,
                end: params.start,
            };
            const map_chunks = chunks.map(chunk_info => {
                /** @type {nb.PartInfo} */
                const part = {
                    obj_id: params.obj_id,
                    chunk_id: undefined,
                    multipart_id: params.multipart_id,
                    start: params.start,
                    end: params.start + chunk_info.size,
                    seq: params.seq,
                    // millistamp: time_utils.millistamp(),
                    // bucket: params.bucket,
                    // key: params.key,
                    // desc: { ...params.desc, start: params.start },
                };
                // nullify the chunk's data to release the memory buffers
                // since we already coded it into the fragments
                chunk_info.data = undefined;
                chunk_info.tier_id = params.tier_id;
                chunk_info.bucket_id = params.bucket_id;
                chunk_info.parts = [part];
                for (const frag of chunk_info.frags) frag.blocks = [];
                const chunk = new ChunkAPI(chunk_info);
                params.seq += 1;
                params.start += chunk.size;
                params.range.end = params.start;
                complete_params.size += chunk.size;
                complete_params.num_parts += 1;
                dbg.log0('UPLOAD: part', part.start, chunk);
                return chunk;
            });
            const mc = new MapClient({
                chunks: map_chunks,
                location_info: params.location_info,
                check_dups: true,
                rpc_client: params.client,
                desc: params.desc,
                read_frags: (part, frags) => this._read_frags(params, part, frags),
                report_error: (block_md, action, err) => this._report_error_on_object_upload(params, block_md, action, err),
            });
            await mc.run();
            if (mc.had_errors) throw new Error('Upload map errors');
            return callback();
        } catch (err) {
            dbg.error('UPLOAD: _upload_chunks', err.stack || err);
            return callback(err);
        }
    }

    async _report_error_on_object_upload(params, block_md, action, err) {
        try {
            await params.client.object.report_error_on_object({
                action: 'upload',
                obj_id: params.obj_id,
                bucket: params.bucket,
                key: params.key,
                blocks_report: [{
                    block_md: block_md,
                    action: action,
                    rpc_code: err.rpc_code || '',
                    error_message: err.message || '',
                }]
            });
        } catch (reporting_err) {
            // reporting failed, we don't have much to do with it now
            // so will drop it, and wait for next failure to retry reporting
            dbg.warn('_report_error_on_object_upload:',
                'will throw original upload error',
                'and ignore this reporting error -', reporting_err);
        }
    }



    ////////////////////////////////////////////////////////////////////////////
    // READ FLOW ///////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////


    /**
     *
     * read entire object to memory buffer.
     * for testing.
     *
     */
    async read_entire_object(params) {
        return buffer_utils.read_stream_join(this.read_object_stream(params));
    }


    /**
     *
     * returns a readable stream to the object.
     * see ObjectReader.
     * @param {Object} params
     * @param {number} [params.watermark]
     * @param {number} [params.start]
     * @param {number} [params.end]
     * @param {Object} [params.client]
     * @param {string} [params.obj_id]
     * @param {string} [params.version_id]
     * @param {string} [params.bucket]
     * @param {string} [params.key]
     * @param {Object} [params.object_md]
     * @returns {ObjectReadable}
     */
    read_object_stream(params) {
        const reader = new ObjectReadable(params, requested_size => {
            if (reader.closed) {
                dbg.log1('READ reader closed', reader.pos);
                reader.push(null);
                return;
            }
            if (reader.pending.length) {
                reader.push(reader.pending.shift());
                return;
            }
            const io_sem_size = _get_io_semaphore_size(requested_size);
            const requested_end = Math.min(reader.end, reader.pos + requested_size);
            this._io_buffers_sem.surround_count(io_sem_size, () => P.resolve()
                    .then(() => this.read_object_with_cache({
                        client: params.client,
                        obj_id: params.obj_id,
                        bucket: params.bucket,
                        key: params.key,
                        start: reader.pos,
                        end: requested_end,
                    }))
                    .then(buffers => {
                        if (buffers && buffers.length) {
                            for (let i = 0; i < buffers.length; ++i) {
                                reader.pos += buffers[i].length;
                                reader.pending.push(buffers[i]);
                            }
                            dbg.log1('READ reader pos', reader.pos);
                            reader.push(reader.pending.shift());
                        } else {
                            reader.push(null);
                            dbg.log1('READ reader finished', reader.pos);
                        }
                    })
                )
                .catch(err => {
                    this._handle_semaphore_errors(params.client, err);
                    dbg.error('READ reader error', err.stack || err);
                    reader.emit('error', err || 'reader error');
                });

            // when starting to stream also prefrech the last part of the file
            // since some video encodings put a chunk of video metadata in the end
            // and it is often requested once doing a video time seek.
            // see https://trac.ffmpeg.org/wiki/Encode/H.264#faststartforwebvideo
            if (!params.start &&
                params.object_md &&
                params.object_md.size > 1024 * 1024 &&
                params.object_md.content_type.startsWith('video') &&
                this._io_buffers_sem.waiting_time < config.VIDEO_READ_STREAM_PRE_FETCH_LOAD_CAP) {
                const tail_io_sem_size = _get_io_semaphore_size(1024);
                P.delay(10)
                    .then(() => this._io_buffers_sem.surround_count(tail_io_sem_size, () =>
                        this.read_object_with_cache({
                            client: params.client,
                            obj_id: params.obj_id,
                            bucket: params.bucket,
                            key: params.key,
                            start: params.object_md.size - 1024,
                            end: params.object_md.size,
                        })
                    ))
                    .catch(err => {
                        this._handle_semaphore_errors(params.client, err);
                        dbg.error('READ prefetch end of file error', err);
                    });
            }
        });
        return reader;
    }


    /**
     *
     * read_object_with_cache
     *
     * @param {Object} params
     * @param {Object} params.client rpc client with auth info if needed
     * @param {string} params.obj_id
     * @param {string} params.bucket
     * @param {string} params.key
     * @param {number} params.start object start offset
     * @param {number} params.end object end offset
     * @returns {Promise<Buffer[]>} a portion of data.
     *      this is mostly likely shorter than requested, and the reader should repeat.
     *      null is returned on empty range or EOF.
     */
    async read_object_with_cache(params) {
        dbg.log1('READ read_object_with_cache: range', range_utils.human_range(params));
        if (!params.obj_id) throw new Error(util.format('read_object_with_cache: no obj_id provided', params));

        if (params.end <= params.start) {
            // empty read range
            return null;
        }

        let pos = params.start;
        const promises = [];

        while (pos < params.end && promises.length < config.IO_READ_RANGE_CONCURRENCY) {
            let range = _.clone(params);
            range.start = pos;
            range.end = Math.min(
                params.end,
                range_utils.align_up(pos + 1, config.IO_OBJECT_RANGE_ALIGN)
            );
            dbg.log2('READ read_object_with_cache: submit concurrent range', range_utils.human_range(range));
            promises.push(this._read_cache.get_with_cache(range));
            pos = range.end;
        }

        const buffers = await Promise.all(promises);
        return _.filter(buffers, b => b && b.length);
    }


    /**
     *
     * _init_read_cache
     *
     */
    _init_read_cache() {
        this._read_cache = new LRUCache({
            name: 'ReadCache',
            max_usage: 256 * 1024 * 1024, // 128 MB
            item_usage: (data, params) => (data && data.buffer && data.buffer.length) || 1024,
            make_key: params => {
                const start = range_utils.align_down(
                    params.start, config.IO_OBJECT_RANGE_ALIGN);
                const end = start + config.IO_OBJECT_RANGE_ALIGN;
                return params.obj_id + '\0' + start + '\0' + end;
            },
            load: params => {
                const range_params = _.clone(params);
                range_params.start = range_utils.align_down(
                    params.start, config.IO_OBJECT_RANGE_ALIGN);
                range_params.end = range_params.start + config.IO_OBJECT_RANGE_ALIGN;
                dbg.log1('READ ReadCache: load', range_utils.human_range(range_params), params.key);
                return this.read_object(range_params);
            },
            validate: (data, params) => params.client.object.read_object_md({
                    obj_id: params.obj_id,
                    bucket: params.bucket,
                    key: params.key
                })
                .then(object_md => {
                    const validated =
                        object_md.obj_id === data.object_md.obj_id &&
                        object_md.etag === data.object_md.etag &&
                        object_md.size === data.object_md.size &&
                        object_md.create_time === data.object_md.create_time;
                    if (!validated) {
                        dbg.log0('READ ReadCache: invalidated', params.bucket, params.key);
                    }
                    return validated;
                }),
            make_val: (data, params) => {
                const buffer = data.buffer;
                if (!buffer) {
                    dbg.log3('READ ReadCache: null', range_utils.human_range(params));
                    return buffer;
                }
                const start = range_utils.align_down(
                    params.start, config.IO_OBJECT_RANGE_ALIGN);
                const end = start + config.IO_OBJECT_RANGE_ALIGN;
                const inter = range_utils.intersection(
                    start, end, params.start, params.end);
                if (!inter) {
                    dbg.log3('READ ReadCache: empty', range_utils.human_range(params),
                        'align', range_utils.human_range({
                            start: start,
                            end: end
                        }));
                    return null;
                }
                dbg.log3('READ ReadCache: slice', range_utils.human_range(params),
                    'inter', range_utils.human_range(inter), 'buffer', buffer.length);
                return buffer.slice(inter.start - start, inter.end - start);
            },
        });
    }



    /**
     *
     * read_object
     *
     * @return {Promise} buffer - the data. can be shorter than requested if EOF.
     *
     */
    read_object(params) {
        let mappings;

        dbg.log2('READ read_object:', range_utils.human_range(params));

        // get meta data on object range we want to read
        let map_params = _.omit(params, 'client');
        map_params.location_info = this.location_info;
        return params.client.object.read_object_mappings(map_params)
            .then(mappings_arg => {
                mappings = mappings_arg;
            })
            .then(() => P.map(mappings.parts, part => this._read_part(params, part)))
            .then(() => {
                // once all parts finish we can construct the complete buffer.
                let size = mappings.object_md.size || mappings.object_md.upload_size || 0;
                let end = Math.min(size, params.end);
                return {
                    object_md: mappings.object_md,
                    buffer: combine_parts_buffers_in_range(mappings.parts, params.start, end)
                };
            });
    }


    /**
     * read one part of the object.
     */
    _read_part(params, part) {
        part.desc = _.pick(params, 'bucket', 'key', 'obj_id');
        part.desc.start = part.start;
        dbg.log1('READ _read_part:', part.desc);
        const all_frags = part.chunk.frags;
        const data_frags = _.filter(all_frags, frag => frag.data_index >= 0);

        // start by reading from the data fragments of the chunk
        // because this is most effective and does not require decoding
        return this._read_frags(params, part, data_frags)
            .catch(err => {
                // verification mode will error if data fragments cannot be decoded
                if (this._verification_mode) throw err;
                if (data_frags.length === all_frags.length) throw err;
                dbg.warn('READ _read_part: failed to read data frags, trying all frags',
                    err.stack || err,
                    'err.chunks', util.inspect(err.chunks, true, null, true)
                );
                return this._read_frags(params, part, all_frags);
            })
            .then(() => {
                // verification mode will also read the parity frags and decode it
                // by adding the minimum number of data fragments needed
                if (this._verification_mode) {
                    const parity_frags = _.filter(all_frags, frag => frag.parity_index >= 0);
                    const verify_parity_frags = parity_frags.concat(data_frags.slice(0, data_frags.length - parity_frags.length));
                    const data_from_data_frags = part.chunk.data;
                    return this._read_frags(params, part, verify_parity_frags)
                        .then(() => assert(part.chunk.data.equals(data_from_data_frags)));
                }
            })
            .catch(err => {
                dbg.error('READ _read_part: FAILED',
                    err.stack || err,
                    'part', part,
                    'err.chunks', util.inspect(err.chunks, true, null, true)
                );
                throw err;
            });
    }

    _read_frags(params, part, frags) {
        const chunk = part.chunk;
        chunk.data = undefined;
        chunk.frags = frags;
        chunk.coder = 'dec';
        return P.map(frags, frag => this._read_frag(params, part, frag))
            .then(() => dbg.log2('READ _read_frags: decode chunk', part.desc, util.inspect(chunk, true, null, true)))
            .then(() => P.fromCallback(cb => nb_native().chunk_coder(chunk, cb)));
    }

    _read_frag(params, part, frag) {

        if (frag.data) return;
        if (!frag.blocks) return;
        if (frag.read_promise) return frag.read_promise;

        const frag_desc = _.clone(part.desc);
        frag_desc.frag = get_frag_desc(frag);
        dbg.log1('READ _read_frag:', frag_desc);

        // verification mode reads all the blocks instead of just one
        if (this._verification_mode) {
            frag.read_promise = P.map(frag.blocks, block => P.resolve()
                .then(() => this._read_block(params, block.block_md))
                .then(buffer => {
                    if (block.block_md.digest_type !== part.chunk.chunk_coder_config.frag_digest_type ||
                        block.block_md.digest_b64 !== frag.digest_b64) {
                        throw new Error('READ _read_frag: (_verification_mode) inconsistent replica digests');
                    }
                    if (frag.data) {
                        assert(buffer.equals(frag.data), 'READ _read_frag: (_verification_mode) inconsistent data');
                    } else {
                        frag.data = buffer;
                    }
                })
                .catch(err => this._report_error_on_object_read(params, part, block.block_md, err))
                .finally(() => {
                    frag.read_promise = undefined;
                })
            );
        } else {
            const read_next_block = i => {
                if (i >= frag.blocks.length) return P.resolve(); // no more blocks
                const block = frag.blocks[i];
                return this._read_block(params, block.block_md)
                    .then(buffer => {
                        frag.data = buffer;
                    })
                    .catch(err => this._report_error_on_object_read(params, part, block.block_md, err))
                    .catch(() => read_next_block(i + 1));
            };
            frag.read_promise = read_next_block(0)
                .finally(() => {
                    frag.read_promise = undefined;
                });
        }

        return frag.read_promise;
    }

    /**
     *
     * _read_block
     *
     * read a block from the storage node
     *
     */
    _read_block(params, block_md) {
        // use semaphore to surround the IO
        return this._block_read_sem_agent.surround_key(String(block_md.node), () =>
                this._block_read_sem_global.surround(() => {
                    dbg.log1('_read_block:', block_md.id, 'from', block_md.address);

                    this._error_injection_on_read();

                    return block_store_client.read_block(params.client, {
                        block_md
                    }, {
                        address: block_md.address,
                        timeout: config.IO_READ_BLOCK_TIMEOUT,
                        auth_token: null // ignore the client options when talking to agents
                    });
                })
            )
            .then(res => {
                const data = res[RPC_BUFFERS].data;

                // verification mode checks here the block digest.
                // this detects tampering which the agent did not report which means the agent is hacked.
                // we don't do this in normal mode because our native decoding checks it,
                // however the native code does not return a TAMPERING error that the system understands.
                // TODO GUY OPTIMIZE translate tampering errors from native decode (also for normal mode)
                if (this._verification_mode) {
                    const digest_b64 = crypto.createHash(block_md.digest_type).update(data).digest('base64');
                    if (digest_b64 !== block_md.digest_b64) {
                        throw new RpcError('TAMPERING',
                            'Block digest varification failed ' + block_md.id);
                    }
                }

                return data;
            })
            .catch(err => {
                dbg.error('_read_block: FAILED', block_md.id, 'from', block_md.address, err);
                throw err;
            });
    }

    _report_error_on_object_read(params, part, block_md, err) {
        return params.client.object.report_error_on_object({
                action: 'read',
                bucket: params.bucket,
                key: params.key,
                start: part.start,
                end: part.end,
                blocks_report: [{
                    block_md: block_md,
                    action: 'read',
                    rpc_code: err.rpc_code || '',
                    error_message: err.message || '',
                }]
            })
            .catch(reporting_err => {
                // reporting failed, we don't have much to do with it now
                // so will drop it, and wait for next failure to retry reporting
                dbg.warn('report_error_on_object_read:',
                    'will throw original upload error',
                    'and ignore this reporting error -', reporting_err);
            })
            .finally(() => {
                // throw the original read error, for the convinience of the caller
                throw err;
            });
    }

    _error_injection_on_read() {
        if (config.ERROR_INJECTON_ON_READ &&
            config.ERROR_INJECTON_ON_READ > Math.random()) {
            throw new RpcError('ERROR_INJECTON_ON_READ');
        }
    }

    _handle_semaphore_errors(client, err) {
        const HOUR_IN_MILI = 3600000;
        if (err.code === 'OBJECT_IO_STREAM_ITEM_TIMEOUT') {
            const curr_date = Date.now();
            if (curr_date - this._last_io_bottleneck_report >= HOUR_IN_MILI) {
                this._last_io_bottleneck_report = curr_date;
                // Not interested in waiting for the response in order to not choke the upload
                client.object.report_endpoint_problems({
                        problem: 'STRESS',
                        node_id: this.location_info && this.location_info.node_id,
                        host_id: this.location_info && this.location_info.host_id,
                    })
                    .catch(error => {
                        dbg.error('_handle_semaphore_errors: had an error', error);
                    });
            }
            throw new RpcError('OBJECT_IO_STREAM_ITEM_TIMEOUT');
        }
    }

}



// INTERNAL ///////////////////////////////////////////////////////////////////



function combine_parts_buffers_in_range(parts, start, end) {
    if (end <= start) {
        // empty read range
        return null;
    }
    if (!parts || !parts.length) {
        dbg.error('no parts for data', range_utils.human_range({
            start: start,
            end: end
        }));
        throw new Error('no parts for data');
    }
    let pos = start;
    /** @type {Buffer[]} */
    const buffers = [];
    _.forEach(parts, part => {
        let part_range = range_utils.intersection(part.start, part.end, pos, end);
        if (!part_range) return;
        let buffer_start = part_range.start - part.start;
        let buffer_end = part_range.end - part.start;
        if (part.chunk_offset) {
            buffer_start += part.chunk_offset;
            buffer_end += part.chunk_offset;
        }
        pos = part_range.end;
        buffers.push(part.chunk.data.slice(buffer_start, buffer_end));
    });
    if (pos !== end) {
        dbg.error('missing parts for data',
            range_utils.human_range({ start, end }),
            'pos', pos, parts);
        throw new Error('missing parts for data');
    }
    const buffer = buffer_utils.join(buffers);
    if (buffer.length !== end - start) {
        dbg.error('short buffer from parts',
            range_utils.human_range({ start, end }),
            'pos', pos, parts);
        throw new Error('short buffer from parts');
    }
    return buffer;
}

function get_frag_desc(frag) {
    if (frag.data_index >= 0) return `D${frag.data_index}`;
    if (frag.parity_index >= 0) return `P${frag.parity_index}`;
    if (frag.lrc_index >= 0) return `L${frag.lrc_index}`;
    throw new Error('BAD FRAG ' + JSON.stringify(frag));
}

function _get_io_semaphore_size(size) {
    // TODO: Currently we have a gap regarding chunked uploads
    // We assume that the chunked upload will take 1MB
    // This is done as a temporary quick fix and is not a good one
    return _.isNumber(size) ? Math.min(config.IO_STREAM_SEMAPHORE_SIZE_CAP, size) :
        config.IO_STREAM_MINIMAL_SIZE_LOCK;
}

module.exports = ObjectIO;
