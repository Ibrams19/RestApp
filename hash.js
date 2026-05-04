const bcrypt = require('bcryptjs');
const hash = bcrypt.hashSync('Halimata#1919', 12);
console.log(hash);