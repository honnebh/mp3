const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const app = require('../server');
const User = require('../models/user');
const Task = require('../models/task');

let database, server, base;
const deadline = '2026-11-10T12:00:00.000Z';
const missingId = '123456789012345678901234';

before(async () => {
    // A separate disposable database; tests never use the Atlas connection.
    database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(database.getUri());
    await User.init();
    await Task.init();
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect();
    if (database) await database.stop();
});

beforeEach(async () => {
    await User.deleteMany({});
    await Task.deleteMany({});
});

async function request(method, path, body, status = 200) {
    const response = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const json = await response.json();
    assert.equal(response.status, status, JSON.stringify(json));
    assert.equal(typeof json.message, 'string');
    assert.ok(Object.hasOwn(json, 'data'));
    return json.data;
}

const user = (name = 'Alice', extra = {}) => request('POST', '/users', {
    name, email: `${name}@example.com`, ...extra
}, 201);
const task = (extra = {}) => request('POST', '/tasks', { name: 'Homework', deadline, ...extra }, 201);
const query = params => '?' + new URLSearchParams(Object.entries(params).map(([key, value]) => [key, JSON.stringify(value)]));

async function snapshot() {
    return JSON.stringify({ users: await User.find().sort('_id').lean(), tasks: await Task.find().sort('_id').lean() });
}

test('creates resources with defaults and server-controlled creation dates', async () => {
    const a = await user('Alice', { dateCreated: '2000-01-01' });
    assert.deepEqual(a.pendingTasks, []);
    assert.ok(new Date(a.dateCreated).getFullYear() > 2000);
    const t = await task({ dateCreated: '2000-01-01' });
    assert.equal(t.description, '');
    assert.equal(t.completed, false);
    assert.equal(t.assignedUser, '');
    assert.equal(t.assignedUserName, 'unassigned');
    assert.equal(t.deadline, deadline);
    assert.ok(new Date(t.dateCreated).getFullYear() > 2000);
});

test('rejects missing fields, incorrect types, and duplicate emails without changing data', async () => {
    await user();
    const original = await snapshot();
    for (const body of [{}, { name: 'A' }, { email: 'a@b.com' }, { name: 1, email: 'a' },
        { name: 'A', email: [] }, { name: ' ', email: 'a' },
        { name: 'A', email: 'Alice@example.com' }, { name: 'A', email: 'a', pendingTasks: null },
        { name: 'A', email: 'a', pendingTasks: ['bad'] }]) {
        await request('POST', '/users', body, 400);
    }
    for (const body of [{}, { name: 'T' }, { deadline }, { name: 'T', deadline: 'bad' },
        { name: 'T', deadline: null }, { name: 'T', deadline: true },
        { name: 'T', deadline, completed: 'false' }, { name: 'T', deadline, description: 2 },
        { name: 'T', deadline, assignedUser: 'bad' }, { name: 'T', deadline, assignedUserName: 1 }]) {
        await request('POST', '/tasks', body, 400);
    }
    assert.equal(await snapshot(), original);
});

test('URL ids take priority over body validation and missing references return 404', async () => {
    for (const resource of ['users', 'tasks']) {
        for (const id of ['bad', missingId]) {
            await request('PUT', `/${resource}/${id}`, {}, 404);
            await request('GET', `/${resource}/${id}`, undefined, 404);
            await request('DELETE', `/${resource}/${id}`, undefined, 404);
        }
    }
    await request('POST', '/users', { name: 'A', email: 'a', pendingTasks: [missingId] }, 404);
    await request('POST', '/tasks', { name: 'T', deadline, assignedUser: missingId }, 404);
    assert.equal(await User.countDocuments(), 0);
    assert.equal(await Task.countDocuments(), 0);
});

test('task assignment, completion, reopening, reassignment, replacement defaults, and deletion', async () => {
    const a = await user();
    const b = await user('Bob');
    const t = await task({ assignedUser: a._id });
    assert.equal(t.assignedUserName, a.name);
    assert.deepEqual((await request('GET', `/users/${a._id}`)).pendingTasks, [t._id]);
    let updated = await request('PUT', `/tasks/${t._id}`, { name: 'Done', deadline, assignedUser: a._id, completed: true });
    assert.equal(updated.assignedUser, a._id);
    assert.deepEqual((await request('GET', `/users/${a._id}`)).pendingTasks, []);
    await request('PUT', `/tasks/${t._id}`, { name: 'Done', deadline, assignedUser: b._id, completed: true });
    assert.deepEqual((await request('GET', `/users/${b._id}`)).pendingTasks, []);
    await request('PUT', `/tasks/${t._id}`, { name: 'Reopen', deadline, assignedUser: b._id, completed: false });
    assert.deepEqual((await request('GET', `/users/${b._id}`)).pendingTasks, [t._id]);
    updated = await request('PUT', `/tasks/${t._id}`, { name: 'Replace', deadline, dateCreated: '2000-01-01' });
    assert.equal(updated.dateCreated, t.dateCreated);
    assert.equal(updated.assignedUser, '');
    assert.equal(updated.assignedUserName, 'unassigned');
    assert.equal(updated.description, '');
    assert.deepEqual((await request('GET', `/users/${b._id}`)).pendingTasks, []);
    await request('PUT', `/tasks/${t._id}`, { name: 'Delete me', deadline, assignedUser: a._id });
    await request('DELETE', `/tasks/${t._id}`);
    assert.deepEqual((await request('GET', `/users/${a._id}`)).pendingTasks, []);
    await request('GET', `/tasks/${t._id}`, undefined, 404);
});

test('user creation and replacement move tasks, remove old assignments, and rename completed assignments', async () => {
    const t = await task();
    const a = await user('Alice', { pendingTasks: [t._id] });
    assert.equal((await request('GET', `/tasks/${t._id}`)).assignedUser, a._id);
    const b = await user('Bob', { pendingTasks: [t._id] });
    assert.deepEqual((await request('GET', `/users/${a._id}`)).pendingTasks, []);
    const done = await task({ assignedUser: b._id, completed: true });
    const second = await task({ assignedUser: a._id });
    const updated = await request('PUT', `/users/${b._id}`, {
        name: 'Bobby', email: b.email, pendingTasks: [second._id], dateCreated: '2000-01-01'
    });
    assert.equal(updated.dateCreated, b.dateCreated);
    assert.equal((await request('GET', `/tasks/${t._id}`)).assignedUser, '');
    assert.equal((await request('GET', `/tasks/${done._id}`)).assignedUserName, 'Bobby');
    assert.equal((await request('GET', `/tasks/${second._id}`)).assignedUser, b._id);
    assert.deepEqual((await request('GET', `/users/${a._id}`)).pendingTasks, []);
    await request('PUT', `/users/${b._id}`, { name: 'Bob', email: b.email });
    assert.equal((await request('GET', `/tasks/${second._id}`)).assignedUser, '');
    assert.equal((await request('GET', `/tasks/${done._id}`)).assignedUser, b._id);
    await request('DELETE', `/users/${b._id}`);
    const unassigned = await request('GET', `/tasks/${done._id}`);
    assert.equal(unassigned.assignedUser, '');
    assert.equal(unassigned.assignedUserName, 'unassigned');
    await request('GET', `/users/${b._id}`, undefined, 404);
});

test('rejects inconsistent assignments and failed replacements preserve all documents', async () => {
    const a = await user();
    const b = await user('Bob');
    const t = await task({ assignedUser: a._id });
    const done = await task({ assignedUser: a._id, completed: true });
    const original = await snapshot();
    await request('PUT', `/users/${a._id}`, { name: 'Changed', email: b.email }, 400);
    await request('PUT', `/users/${a._id}`, { name: 'Changed', email: a.email, pendingTasks: [missingId] }, 404);
    await request('PUT', `/users/${a._id}`, { name: 'Changed', email: a.email, pendingTasks: [done._id] }, 400);
    await request('PUT', `/users/${a._id}`, { name: 'Changed', email: a.email, pendingTasks: [done._id, missingId] }, 400);
    await request('PUT', `/tasks/${t._id}`, { name: 'Changed', deadline, assignedUser: b._id, assignedUserName: a.name }, 400);
    await request('PUT', `/tasks/${t._id}`, { name: 'Changed', deadline, assignedUser: missingId }, 404);
    assert.equal(await snapshot(), original);
});

test('combines Mongoose filters, sorting, projection, pagination and count', async () => {
    await task({ name: 'C', completed: true });
    const a = await task({ name: 'A' });
    const b = await task({ name: 'B' });
    assert.deepEqual(await request('GET', '/tasks' + query({ where: { completed: false }, sort: { name: 1 },
        select: { name: 1, _id: 0 }, skip: 1, limit: 1 })), [{ name: 'B' }]);
    assert.equal(await request('GET', '/tasks' + query({ where: { completed: false }, count: true, limit: 1 })), 2);
    assert.equal((await request('GET', '/tasks' + query({ where: { _id: { $in: [a._id, b._id] } } }))).length, 2);
    assert.deepEqual(await request('GET', '/tasks' + query({ where: { _id: missingId } })), []);
    assert.equal(await request('GET', '/tasks' + query({ where: { _id: missingId }, count: true })), 0);
    await user('Charlie');
    await user('Alice');
    assert.deepEqual(await request('GET', '/users' + query({ sort: { name: 1 }, select: { name: 1, _id: 0 }, skip: 1 })), [{ name: 'Charlie' }]);
});

test('collection limits default to 100 tasks and unlimited users; limit=0 is unlimited', async () => {
    await Task.insertMany(Array.from({ length: 105 }, (_, i) => ({ name: `T${i}`, deadline })));
    await User.insertMany(Array.from({ length: 105 }, (_, i) => ({ name: `U${i}`, email: `u${i}@example.com` })));
    assert.equal((await request('GET', '/tasks')).length, 100);
    assert.equal((await request('GET', '/tasks?limit=0')).length, 105);
    assert.equal((await request('GET', '/users')).length, 105);
});

test('single resources support select and ignore all other query parameters', async () => {
    const a = await user();
    const t = await task();
    for (const [path, resource] of [['users', a], ['tasks', t]]) {
        const selected = await request('GET', `/${path}/${resource._id}` + query({ select: { name: 1, _id: 0 } }) + '&where=broken&sort=broken&skip=broken&limit=broken&count=broken');
        assert.deepEqual(selected, { name: resource.name });
        await request('GET', `/${path}/${resource._id}?select=broken`, undefined, 400);
    }
});

test('malformed query parameters and malformed JSON return readable 400 responses', async () => {
    for (const path of ['/users', '/tasks']) {
        for (const key of ['where', 'sort', 'select', 'skip', 'limit', 'count']) {
            await request('GET', `${path}?${key}=broken`, undefined, 400);
        }
        for (const params of [{ where: [] }, { sort: { name: 3 } }, { select: { name: 2 } },
            { select: { name: 1, deadline: 0 } }, { skip: -1 }, { limit: 1.5 }, { count: 'true' }]) {
            await request('GET', path + query(params), undefined, 400);
        }
    }
    const response = await fetch(base + '/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { message: 'The request body contains invalid JSON.', data: {} });
    const options = await fetch(base + '/users', { method: 'OPTIONS' });
    assert.equal(options.status, 204);
    assert.equal(await options.text(), '');
});

test('database failures return 500 and roll back earlier writes in a transaction', async () => {
    const a = await user();
    const t = await task({ assignedUser: a._id });
    const original = await snapshot();
    const updateMany = Task.updateMany;
    Task.updateMany = () => { throw new Error('Internal database details must not be returned'); };
    try {
        await request('PUT', `/users/${a._id}`, { name: 'Changed', email: a.email, pendingTasks: [t._id] }, 500);
    } finally {
        Task.updateMany = updateMany;
    }
    assert.equal(await snapshot(), original);
});
