/* Copyright (C) 2016 NooBaa */
#include "splitter.h"

#include "../util/common.h"

namespace noobaa
{

// See https://web.eecs.utk.edu/~plank/plank/papers/CS-07-593/primitive-polynomial-table.txt
#define NB_RABIN_POLY 021
#define NB_RABIN_DEGREE 39
#define NB_RABIN_WINDOW_LEN 16

// intialize rabin instance statically for all splitter instances
// we set the rabin properties on compile time for best performance
// and it's not really valuable to make them dynamic
Rabin Splitter::_rabin(NB_RABIN_POLY, NB_RABIN_DEGREE, NB_RABIN_WINDOW_LEN);

Splitter::Splitter(
    int min_chunk,
    int max_chunk,
    int avg_chunk_bits,
    bool calc_md5,
    bool calc_sha256)
    : _min_chunk(min_chunk)
    , _max_chunk(max_chunk)
    , _avg_chunk_bits(avg_chunk_bits)
    , _calc_md5(calc_md5)
    , _calc_sha256(calc_sha256)
    , _window_pos(0)
    , _chunk_pos(0)
    , _hash(0)
{
    assert(_min_chunk > 0);
    assert(_min_chunk <= _max_chunk);
    assert(_avg_chunk_bits >= 0);
    nb_buf_init_alloc(&_window, NB_RABIN_WINDOW_LEN);
    memset(_window.data, 0, _window.len);
    if (calc_md5) {
        EVP_MD_CTX_init(&_md5_ctx);
        EVP_DigestInit_ex(&_md5_ctx, EVP_md5(), NULL);
    }
    if (calc_sha256) {
        EVP_MD_CTX_init(&_sha256_ctx);
        EVP_DigestInit_ex(&_sha256_ctx, EVP_sha256(), NULL);
    }
}

Splitter::~Splitter()
{
    nb_buf_free(&_window);
    if (_calc_md5) EVP_MD_CTX_cleanup(&_md5_ctx);
    if (_calc_sha256) EVP_MD_CTX_cleanup(&_sha256_ctx);
}

void
Splitter::push(const uint8_t* data, int len)
{
    if (_calc_md5) EVP_DigestUpdate(&_md5_ctx, data, len);
    if (_calc_sha256) EVP_DigestUpdate(&_sha256_ctx, data, len);
    while (_next_point(&data, &len)) {
        _split_points.push_back(_chunk_pos);
        _chunk_pos = 0;
    }
}

void
Splitter::finish(uint8_t* md5, uint8_t* sha256)
{
    if (md5 && _calc_md5) EVP_DigestFinal_ex(&_md5_ctx, md5, 0);
    if (sha256 && _calc_sha256) EVP_DigestFinal_ex(&_sha256_ctx, sha256, 0);
}

bool
Splitter::_next_point(const uint8_t** const p_data, int* const p_len)
{
    // this code is very tight on CPU,
    // se we copy the memory that gets accessed frequently to the stack,
    // to be as close as possible to the CPU.

    int window_pos = _window_pos;
    const int window_len = _window.len;
    uint8_t* const window_data = _window.data;

    int chunk_pos = _chunk_pos;
    const int total = chunk_pos + (*p_len);
    const int min = total < _min_chunk ? total : _min_chunk;
    const int max = total < _max_chunk ? total : _max_chunk;

    Rabin::Hash hash = _hash;
    const Rabin::Hash avg_chunk_mask = ~(~((Rabin::Hash)0) << _avg_chunk_bits);
    const Rabin::Hash avg_chunk_val = ~((Rabin::Hash)0) & avg_chunk_mask;

    const uint8_t* data = *p_data;
    bool boundary = false;

    // skip byte scanning as long as below min chunk length
    if (chunk_pos < min) {
        data += min - chunk_pos;
        chunk_pos = min;
    }

    // now the heavy part is to scan byte by byte,
    // update the rolling hash by adding the next byte and popping the old byte,
    // and check if the hash marks a chunk boundary.
    while (chunk_pos < max) {
        hash = _rabin.update(hash, *data, window_data[window_pos]);
        window_data[window_pos] = *data;
        window_pos++;
        chunk_pos++;
        data++;
        if (window_pos >= window_len) window_pos = 0;
        if ((hash & avg_chunk_mask) == avg_chunk_val) {
            boundary = true;
            break;
        }
    }

    if (boundary || chunk_pos >= _max_chunk) {
        const int n = (int)(data - (*p_data));
        memset(window_data, 0, window_len);
        _window_pos = 0;
        _chunk_pos = chunk_pos;
        _hash = 0;
        *p_data = data;
        *p_len -= n;
        return true;
    } else {
        _window_pos = window_pos;
        _chunk_pos = chunk_pos;
        _hash = hash;
        *p_data = 0;
        *p_len = 0;
        return false;
    }
}
}
