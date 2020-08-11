"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Client-side library to interact with Grist.
 */
const axios_1 = require("axios");
const _debug = require("debug");
const chunk = require("lodash/chunk");
const mapValues = require("lodash/mapValues");
const pick = require("lodash/pick");
const debug = _debug('grist-api');
const debugReq = _debug('grist-api:requests');
async function getAPIKey() {
    if (typeof process === 'undefined') {
        throw new Error('In browser environment, Grist API key must be provided');
    }
    // Otherwise, assume we are in node environment.
    if (process.env.GRIST_API_KEY) {
        return process.env.GRIST_API_KEY;
    }
    const os = require('os');
    const path = require('path');
    const fse = require('fs-extra');
    const keyPath = path.join(os.homedir(), ".grist-api-key");
    if (fse.pathExists(keyPath)) {
        return (await fse.readFile(keyPath, { encoding: 'utf8' })).trim();
    }
    throw new Error(`Grist API key not found in GRIST_API_KEY env, nor in ${keyPath}`);
}
exports.getAPIKey = getAPIKey;
/**
 * Class for interacting with a Grist document.
 */
class GristDocAPI {
    /**
     * Create a GristDocAPI object. You may specify either a doc URL, or just the doc ID (the part
     * of the URL after "/doc/"). If you specify a URL, then options.server is unneeded and ignored.
     *
     * See documentation of IGristCallConfig for options.
     */
    constructor(docUrlOrId, options = {}) {
        this._dryrun = Boolean(options.dryrun);
        this._server = options.server || 'https://api.getgrist.com';
        this._apiKey = options.apiKey || null;
        this._chunkSize = options.chunkSize || 500;
        const match = /^(https?:.*)\/doc\/([^\/?#]+)/.exec(docUrlOrId);
        if (match) {
            this._server = match[1];
            this._docId = match[2];
        }
        else {
            this._docId = docUrlOrId;
        }
    }
    /**
     * Fetch all data in the table by the given name, returning a list of records with attributes
     * corresponding to the columns in that table.
     *
     * If filters is given, it should be a dictionary mapping column names to values, to fetch only
     * records that match.
     */
    async fetchTable(tableName, filters) {
        const query = filters ? `?filter=${encodeURIComponent(JSON.stringify(filters))}` : '';
        const data = await this._docCall(`tables/${tableName}/data${query}`);
        if (!Array.isArray(data.id)) {
            throw new Error(`fetchTable ${tableName} returned bad response: id column is not an array`);
        }
        // Convert column-oriented data to list of records.
        debug("fetchTable %s returned %s rows", tableName, data.id.length);
        return data.id.map((id, index) => mapValues(data, (col) => col[index]));
    }
    /**
     * Adds new records to the given table. The data is a list of dictionaries, with keys
     * corresponding to the columns in the table. Returns a list of added rowIds.
     */
    async addRecords(tableName, records) {
        if (records.length === 0) {
            return [];
        }
        const callData = chunk(records, this._chunkSize).map((recs) => makeTableData(recs));
        const results = [];
        for (const data of callData) {
            debug("addRecords %s %s", tableName, descColValues(data));
            const resp = await this._docCall(`tables/${tableName}/data`, data, 'POST');
            results.push(...(resp || []));
        }
        return results;
    }
    /**
     * Deletes records from the given table. The data is a list of record IDs.
     */
    async deleteRecords(tableName, recordIds) {
        // There is an endpoint missing to delete records, but we can use the "apply" endpoint
        // meanwhile.
        for (const recIds of chunk(recordIds, this._chunkSize)) {
            debug("delete_records %s %s records", tableName, recIds.length);
            const data = [['BulkRemoveRecord', tableName, recIds]];
            await this._docCall('apply', data, 'POST');
        }
    }
    /**
     * Update existing records in the given table. The data is a list of objects, with attributes
     * corresponding to the columns in the table. Each record must contain the key "id" with the
     * rowId of the row to update.
     *
     * If records aren't all for the same set of columns, then a single-call update is impossible,
     * so we'll make multiple calls.
     */
    async updateRecords(tableName, records) {
        const groups = new Map();
        for (const rec of records) {
            if (!rec.id || typeof rec.id !== 'number') {
                throw new Error("updateRecord requires numeric 'id' attribute in each record");
            }
            const key = JSON.stringify(Object.keys(rec).sort());
            const group = groups.get(key) || groups.set(key, []).get(key);
            group.push(rec);
        }
        const callData = [];
        for (const groupRecords of groups.values()) {
            callData.push(...chunk(groupRecords, this._chunkSize).map((recs) => makeTableData(recs)));
        }
        for (const data of callData) {
            debug("updateRecods %s %s", tableName, descColValues(data));
            // If a call fails, other calls won't run. TODO we should think of how to do better, perhaps
            // with undo of actions that did succeed (but that has dangers if other code ran in the
            // meantime), or better figuring out a path to transactions.
            await this._docCall(`tables/${tableName}/data`, data, 'PATCH');
        }
    }
    /**
     * Updates Grist table with new data, updating existing rows or adding new ones, matching rows on
     * the given key columns. (This method does not remove rows from Grist.)
     *
     * New data is a list of objects with column IDs as attributes.
     *
     * keyColIds parameter lists primary-key columns, which must be present in the given records.
     *
     * If filters is given, it should be a dictionary mapping colIds to values, where colIds must be
     * included among keyColIds. Only existing records matching these filters will be matched as
     * candidates for rows to update. New records which don't match filters will be ignored too.
     */
    async syncTable(tableName, records, keyColIds, options = {}) {
        const filters = options.filters;
        if (filters && !Object.keys(filters).every((colId) => keyColIds.includes(colId))) {
            throw new Error("syncTable requires key columns to include all filter columns");
        }
        // Maps unique keys to Grist rows
        const gristRows = new Map();
        for (const oldRec of await this.fetchTable(tableName, filters)) {
            const key = JSON.stringify(keyColIds.map((colId) => oldRec[colId]));
            gristRows.set(key, oldRec);
        }
        const updateList = [];
        const addList = [];
        let dataCount = 0;
        let filteredOut = 0;
        for (const newRec of records) {
            // If we have any filters, ignore new records which don't match them.
            if (filters && !filterMatches(newRec, filters)) {
                filteredOut += 1;
                continue;
            }
            dataCount += 1;
            const key = JSON.stringify(keyColIds.map((colId) => newRec[colId]));
            const oldRec = gristRows.get(key);
            if (oldRec) {
                // TODO: This considers non-primitive values always distinct (e.g. ['d', 1234567]). On the
                // other hand, it's unclear if non-primitive values are ever useful.
                const changedKeys = Object.keys(newRec).filter((colId) => newRec[colId] !== oldRec[colId]);
                if (changedKeys.length > 0) {
                    debug("syncTable %s: #%s %s needs updates", tableName, oldRec.id, key, changedKeys.map((colId) => [colId, oldRec[colId], newRec[colId]]));
                    const update = pick(newRec, changedKeys);
                    update.id = oldRec.id;
                    updateList.push(update);
                }
            }
            else {
                debug("syncTable %s: %s not in grist", tableName, key);
                addList.push(newRec);
            }
        }
        debug("syncTable %s (%s) with %s records (%s filtered out): %s updates, %s new", tableName, gristRows.size, dataCount, filteredOut, updateList.length, addList.length);
        // TODO As for other calls, without transactions, we can be left with only a partial sync if
        // there is an error.
        await this.updateRecords(tableName, updateList);
        await this.addRecords(tableName, addList);
    }
    async attach(files) {
        const formData = new FormData();
        for (const file of files) {
            formData.append('upload', file);
        }
        return await this._docCall('attach', formData, 'POST');
    }
    /**
     * Low-level interface to make a REST call.
     */
    async _docCall(docRelUrl, data, method) {
        return this._call(`/api/docs/${this._docId}/${docRelUrl}`, data, method);
    }
    async _call(url, data, method) {
        const fullUrl = `${this._server}${url}`;
        method = method || (data ? 'POST' : 'GET');
        if (this._dryrun && method.toUpperCase() !== 'GET') {
            debug("DRYRUN NOT sending %s request to %s", method, fullUrl);
            return;
        }
        if (!this._apiKey) {
            // If key is missing, get it on first use (possibly from a file), since the constructor can't be async.
            this._apiKey = await getAPIKey();
        }
        debug("Sending %s request to %s", method, fullUrl);
        try {
            const request = {
                url: fullUrl,
                method,
                data,
                headers: {
                    'Authorization': `Bearer ${this._apiKey}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
            };
            debugReq("Request", request);
            const response = await axios_1.default.request(request);
            return response.data;
        }
        catch (err) {
            // If the error has {"error": ...} content, use that for the error message.
            const errorObj = err.response ? err.response.data : null;
            if (typeof errorObj === 'object' && errorObj && errorObj.error) {
                err.message = "Grist: " + errorObj.error;
            }
            throw err;
        }
    }
}
exports.GristDocAPI = GristDocAPI;
/**
 * Returns a human-readable summary of the given ITableData object (dict mapping column name to
 * list of values).
 */
function descColValues(data) {
    const keys = Object.keys(data);
    const numRows = keys.length > 0 ? data[keys[0]].length : 0;
    const columns = keys.sort().join(', ');
    return `${numRows} rows, cols (${columns})`;
}
/**
 * Converts an array of records into a column-oriented ITableData object.
 */
function makeTableData(records) {
    const allKeys = {};
    for (const rec of records) {
        for (const key of Object.keys(rec)) {
            allKeys[key] = null;
        }
    }
    return mapValues(allKeys, (_, key) => records.map((rec) => rec[key]));
}
/**
 * Checks if a record matches a set of filters.
 */
function filterMatches(rec, filters) {
    // TODO: This considers non-primitive values (e.g. ['d', 1234567] as always non-matching.
    return Object.keys(filters).every((colId) => filters[colId].includes(rec[colId]));
}
//# sourceMappingURL=grist-api.js.map