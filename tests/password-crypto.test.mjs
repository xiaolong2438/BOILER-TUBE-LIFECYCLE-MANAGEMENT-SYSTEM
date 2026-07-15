import assert from 'node:assert/strict';
import { createPasswordRecord, verifyPassword } from '../functions/api/auth/_password.mjs';

const record = await createPasswordRecord('admin-pass');

assert.equal(record.iterations, 210000);
assert.ok(record.salt.length > 0);
assert.ok(record.hash.length > 0);
assert.ok(await verifyPassword('admin-pass', record));
assert.ok(!(await verifyPassword('wrong-pass', record)));
