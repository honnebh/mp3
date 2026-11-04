function fail(status, message) {
    const error = new Error(message);
    error.status = status;
    throw error;
}

function validId(id) {
    return typeof id === 'string' && /^[a-fA-F0-9]{24}$/.test(id);
}

async function findResource(Model, id, session) {
    if (!validId(id)) fail(404, `${Model.modelName} not found.`);
    const document = await Model.findById(id).session(session || null);
    if (!document) fail(404, `${Model.modelName} not found.`);
    return document;
}

function bodyObject(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        fail(400, 'The request body must be an object.');
    }
}

function requiredString(value, field) {
    if (typeof value !== 'string' || !value.trim()) {
        fail(400, `${field} is required and must be a nonempty string.`);
    }
    return value.trim();
}

function optionalString(value, field, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== 'string') fail(400, `${field} must be a string.`);
    return value;
}

function parseParameter(query, name, fallback) {
    if (query[name] === undefined) return fallback;
    if (typeof query[name] !== 'string') fail(400, `${name} must be a JSON value.`);
    try {
        return JSON.parse(query[name]);
    } catch {
        fail(400, `${name} must contain valid JSON.`);
    }
}

function objectParameter(query, name) {
    const value = parseParameter(query, name, {});
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(400, `${name} must be a JSON object.`);
    }
    return value;
}

function projection(query) {
    const select = objectParameter(query, 'select');
    if (Object.values(select).some(value => value !== 0 && value !== 1)) {
        fail(400, 'select values must be 0 or 1.');
    }
    const values = Object.entries(select).filter(([key]) => key !== '_id').map(([, value]) => value);
    if (values.includes(0) && values.includes(1)) {
        fail(400, 'select cannot mix included and excluded fields, except for _id.');
    }
    return select;
}

function addGetRoutes(router, Model, defaultLimit) {
    router.get('/', async (req, res) => {
        const where = objectParameter(req.query, 'where');
        const sort = objectParameter(req.query, 'sort');
        const select = projection(req.query);
        const skip = parseParameter(req.query, 'skip', 0);
        const limit = parseParameter(req.query, 'limit', defaultLimit);
        const count = parseParameter(req.query, 'count', false);
        if (Object.values(sort).some(value => value !== 1 && value !== -1)) {
            fail(400, 'sort values must be 1 or -1.');
        }
        if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(limit) || limit < 0) {
            fail(400, 'skip and limit must be nonnegative integers.');
        }
        if (typeof count !== 'boolean') fail(400, 'count must be true or false.');

        // All filtering, ordering, projection, and pagination run in MongoDB.
        let data;
        try {
            data = count
                ? await Model.countDocuments(where)
                : await Model.find(where).sort(sort).select(select).skip(skip).limit(limit);
        } catch (error) {
            if (error.name === 'CastError' || error.name === 'StrictModeError' ||
                [2, 9, 14, 168, 31253, 31254].includes(error.code)) {
                fail(400, 'The query contains an invalid field value or operator.');
            }
            throw error;
        }
        res.json({ message: 'OK', data });
    });

    router.get('/:id', async (req, res) => {
        if (!validId(req.params.id)) fail(404, `${Model.modelName} not found.`);
        const data = await Model.findById(req.params.id).select(projection(req.query));
        if (!data) fail(404, `${Model.modelName} not found.`);
        res.json({ message: 'OK', data });
    });
}

module.exports = { fail, validId, findResource, bodyObject, requiredString, optionalString, addGetRoutes };
