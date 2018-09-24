const Hab = require('./lib/Hab.js');


// create a default instance
const hab = new Hab();


// expose exec function for default instance as export
module.exports = function () {
    return hab.exec.apply(hab, arguments);
};


// expose default instance as prototype of exported exec function
Object.setPrototypeOf(module.exports, hab);


// expose class prototype
module.exports.Hab = Hab;
