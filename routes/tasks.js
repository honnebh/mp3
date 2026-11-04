const router = require('express').Router();
const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');
const { fail, validId, findResource, bodyObject, requiredString, optionalString, addGetRoutes } = require('./helpers');

addGetRoutes(router, Task, 100);

async function saveTask(req, res) {
    const replacing = req.method === 'PUT';
    const data = await mongoose.connection.transaction(async session => {
        const task = replacing ? await findResource(Task, req.params.id, session) : new Task();
        bodyObject(req.body);
        const name = requiredString(req.body.name, 'name');
        const rawDeadline = req.body.deadline;
        if (!['string', 'number'].includes(typeof rawDeadline) ||
            (typeof rawDeadline === 'string' && !rawDeadline.trim()) ||
            !Number.isFinite(new Date(rawDeadline).getTime())) {
            fail(400, 'deadline is required and must be a valid date.');
        }
        const deadline = new Date(rawDeadline);
        const description = optionalString(req.body.description, 'description', '');
        let completed = req.body.completed === undefined ? false : req.body.completed;
        if (req.is('application/x-www-form-urlencoded') && ['true', 'false'].includes(completed)) {
            completed = completed === 'true';
        }
        if (typeof completed !== 'boolean') fail(400, 'completed must be a boolean.');
        let assignedUser = optionalString(req.body.assignedUser, 'assignedUser', '');
        let assignedUserName = optionalString(req.body.assignedUserName, 'assignedUserName', undefined);
        if (assignedUser && !validId(assignedUser)) fail(400, 'assignedUser must be a valid user id or an empty string.');
        assignedUser = assignedUser.toLowerCase();
        if (assignedUser) {
            const user = await User.findById(assignedUser).session(session);
            if (!user) fail(404, 'Assigned user not found.');
            if (assignedUserName !== undefined && assignedUserName !== user.name) {
                fail(400, 'assignedUserName must match the assigned user’s name.');
            }
            assignedUserName = user.name;
        } else {
            assignedUserName = 'unassigned';
        }

        task.set({ name, description, deadline, completed, assignedUser, assignedUserName });
        await task.save({ session });
        const taskId = task._id.toString();
        await User.updateMany({ pendingTasks: taskId }, { $pull: { pendingTasks: taskId } }, { session });
        if (assignedUser && !completed) {
            await User.updateOne({ _id: assignedUser }, { $addToSet: { pendingTasks: taskId } }, { session });
        }
        return task.toObject();
    });
    res.status(replacing ? 200 : 201).json({ message: replacing ? 'Task updated.' : 'Task created.', data });
}

router.post('/', saveTask);
router.put('/:id', saveTask);
router.delete('/:id', async (req, res) => {
    await mongoose.connection.transaction(async session => {
        const task = await findResource(Task, req.params.id, session);
        await User.updateMany({ pendingTasks: task._id.toString() }, {
            $pull: { pendingTasks: task._id.toString() }
        }, { session });
        await task.deleteOne({ session });
    });
    res.status(204).end();
});

module.exports = router;
