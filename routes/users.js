const router = require('express').Router();
const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');
const { fail, validId, findResource, bodyObject, requiredString, addGetRoutes } = require('./helpers');

addGetRoutes(router, User, 0);

async function saveUser(req, res) {
    const replacing = req.method === 'PUT';
    const data = await mongoose.connection.transaction(async session => {
        const user = replacing ? await findResource(User, req.params.id, session) : new User();
        bodyObject(req.body);
        const name = requiredString(req.body.name, 'name');
        const email = requiredString(req.body.email, 'email');
        let pendingTasks = req.body.pendingTasks === undefined ? [] : req.body.pendingTasks;
        if (req.is('application/x-www-form-urlencoded') && typeof pendingTasks === 'string') {
            try { pendingTasks = JSON.parse(pendingTasks); } catch { fail(400, 'pendingTasks must be an array of task ids.'); }
        }
        if (!Array.isArray(pendingTasks) || pendingTasks.some(id => !validId(id))) {
            fail(400, 'pendingTasks must be an array of valid task ids.');
        }
        pendingTasks = [...new Set(pendingTasks.map(id => id.toLowerCase()))];
        if (await User.exists({ email, _id: { $ne: user._id } }).session(session)) {
            fail(400, 'That email is already used by another user.');
        }
        const tasks = await Task.find({ _id: { $in: pendingTasks } }).session(session);
        if (tasks.some(task => task.completed)) fail(400, 'Completed tasks cannot be in pendingTasks.');
        if (tasks.length !== pendingTasks.length) fail(404, 'One or more pending tasks were not found.');

        const userId = user._id.toString();
        const removed = user.pendingTasks.filter(id => !pendingTasks.includes(id));
        user.set({ name, email, pendingTasks });
        await user.save({ session });
        await Task.updateMany({ _id: { $in: removed }, assignedUser: userId }, {
            $set: { assignedUser: '', assignedUserName: 'unassigned' }
        }, { session });
        // A task can move from another user's list into this user's list.
        await User.updateMany({ _id: { $ne: user._id }, pendingTasks: { $in: pendingTasks } }, {
            $pull: { pendingTasks: { $in: pendingTasks } }
        }, { session });
        await Task.updateMany({ _id: { $in: pendingTasks } }, {
            $set: { assignedUser: userId, assignedUserName: name }
        }, { session });
        // Renaming a user also updates their completed tasks.
        await Task.updateMany({ assignedUser: userId }, { $set: { assignedUserName: name } }, { session });
        return user.toObject();
    });
    res.status(replacing ? 200 : 201).json({ message: replacing ? 'User updated.' : 'User created.', data });
}

router.post('/', saveUser);
router.put('/:id', saveUser);
router.delete('/:id', async (req, res) => {
    await mongoose.connection.transaction(async session => {
        const user = await findResource(User, req.params.id, session);
        await Task.updateMany({ assignedUser: user._id.toString() }, {
            $set: { assignedUser: '', assignedUserName: 'unassigned' }
        }, { session });
        await user.deleteOne({ session });
    });
    res.json({ message: 'User deleted.', data: {} });
});

module.exports = router;
