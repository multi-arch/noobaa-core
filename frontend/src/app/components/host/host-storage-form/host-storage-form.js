/* Copyright (C) 2016 NooBaa */

import template from './host-storage-form.html';
import Observer from 'observer';
import StorageNodeRowViewModel from './storage-node-row';
import { state$ } from 'state';
import ko from 'knockout';
import { deepFreeze } from 'utils/core-utils';

const columns = deepFreeze([
    {
        name: 'state',
        type: 'icon'
    },
    {
        name: 'mount'
    },
    {
        name: 'readLatency'
    },
    {
        name: 'writeLatency'
    },
    {
        name: 'capacity',
        label: 'Used Capacity',
        type: 'capacity'
    },
    {
        name: 'dataActivity'
    }
]);

class HostStorageFormViewModel extends Observer {
    constructor({ name }) {
        super();

        this.columns = columns;
        this.hostLoaded = ko.observable(false);
        this.driveCount = ko.observable('');
        this.mode = ko.observable('');
        this.os = ko.observable('');
        this.rows = ko.observableArray();

        this.observe(state$.get('hosts', 'items', ko.unwrap(name)), this.onHost);
    }

    onHost(host) {
        if (!host) return;

        const { nodes } = host.services.storage;
        const enabledNodes = nodes.filter(node => node.mode !== 'DECOMMISSIONED');
        const rows = nodes.map(
            (node, i) => {
                const row = this.rows.get(i) || new StorageNodeRowViewModel();
                row.onNode(node);
                return row;
            }
        );

        this.os(host.os);
        this.driveCount(`${nodes.length} of ${enabledNodes.length}`);
        this.rows(rows);
        this.hostLoaded(true);
    }

    onEditDrives() {
    }
}

export default {
    viewModel: HostStorageFormViewModel,
    template: template
};