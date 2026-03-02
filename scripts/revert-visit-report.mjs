import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const APPOINTMENT_ID = '69a5791618baf896d141d384';

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

const apptCol   = db.collection('appointments');
const vrCol     = db.collection('visitreports');
const projCol   = db.collection('projects');

// 1. Revert all SUBMITTED visit reports for this appointment back to DRAFT
const vrResult = await vrCol.updateMany(
  { appointmentId: new mongoose.Types.ObjectId(APPOINTMENT_ID), status: 'submitted' },
  { $set: { status: 'draft' } }
);
console.log(`Visit reports reverted to DRAFT: ${vrResult.modifiedCount}`);

// 2. Delete auto-created projects linked to these visit reports
const visitReports = await vrCol.find(
  { appointmentId: new mongoose.Types.ObjectId(APPOINTMENT_ID) }
).toArray();
const vrIds = visitReports.map(vr => vr._id);

if (vrIds.length > 0) {
  const projResult = await projCol.deleteMany({ visitReportId: { $in: vrIds } });
  console.log(`Auto-created projects deleted: ${projResult.deletedCount}`);
}

// 3. If the appointment was auto-completed, revert it back to CONFIRMED
const appt = await apptCol.findOne({ _id: new mongoose.Types.ObjectId(APPOINTMENT_ID) });
if (appt) {
  console.log(`Current appointment status: ${appt.status}`);
  if (appt.status === 'completed') {
    await apptCol.updateOne(
      { _id: appt._id },
      { $set: { status: 'confirmed' } }
    );
    console.log('Appointment reverted to CONFIRMED');
  } else {
    console.log('Appointment status not "completed", no change needed');
  }
} else {
  console.log('Appointment not found!');
}

console.log('Done.');
await mongoose.disconnect();
