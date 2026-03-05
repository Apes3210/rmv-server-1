/**
 * Deletes a specific appointment and all its linked data (visit reports, projects, payment plans, audit logs).
 * Usage: node scripts/_delete-test-data.mjs <appointmentId>
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';

const { ObjectId } = mongoose.Types;
const appointmentId = process.argv[2];
if (!appointmentId) { console.error('Usage: node scripts/_delete-test-data.mjs <appointmentId>'); process.exit(1); }

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const id = new ObjectId(appointmentId);

// 1. Find linked visit reports
const vrs = await db.collection('visitreports').find({ appointmentId: id }).toArray();
const vrIds = vrs.map(v => v._id);
const projectIds = vrs.flatMap(v => v.linkedProjectId ? [new ObjectId(v.linkedProjectId)] : []);

console.log(`Appointment:   ${appointmentId}`);
console.log(`Visit reports: ${vrIds.length}  ${vrIds.map(x => x.toString()).join(', ')}`);
console.log(`Projects:      ${projectIds.length}  ${projectIds.map(x => x.toString()).join(', ')}`);

// 2. Delete payment plans linked to projects
if (projectIds.length) {
  const r = await db.collection('paymentplans').deleteMany({ projectId: { $in: projectIds } });
  console.log(`Deleted payment plans: ${r.deletedCount}`);
  const r2 = await db.collection('payments').deleteMany({ projectId: { $in: projectIds } });
  console.log(`Deleted payments: ${r2.deletedCount}`);
  const r3 = await db.collection('projects').deleteMany({ _id: { $in: projectIds } });
  console.log(`Deleted projects: ${r3.deletedCount}`);
}

// 3. Delete visit reports
if (vrIds.length) {
  const r = await db.collection('visitreports').deleteMany({ _id: { $in: vrIds } });
  console.log(`Deleted visit reports: ${r.deletedCount}`);
}

// 4. Delete the appointment
const r = await db.collection('appointments').deleteOne({ _id: id });
console.log(`Deleted appointment: ${r.deletedCount}`);

// 5. Clean up audit logs for this appointment
const al = await db.collection('auditlogs').deleteMany({ targetId: id });
console.log(`Deleted audit logs: ${al.deletedCount}`);

// 6. Also release any active slot lock
await db.collection('slotlocks').deleteMany({ appointmentId: id });

console.log('\nDone.');
await mongoose.disconnect();
