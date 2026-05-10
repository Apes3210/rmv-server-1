#!/usr/bin/env node
/**
 * Migration script: Clear address data for all internal staff roles
 * 
 * This script clears addressData and savedAddresses for all non-CUSTOMER roles:
 * - APPOINTMENT_AGENT
 * - SALES_STAFF
 * - ENGINEER
 * - CASHIER
 * - FABRICATION_STAFF
 * - ADMIN
 * 
 * Usage: node clear-internal-staff-addresses.mjs [--dry-run]
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config({ path: '.env' });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/rmv';
const DRY_RUN = process.argv.includes('--dry-run');

const userSchema = new mongoose.Schema(
  {
    email: String,
    roles: [String],
    addressData: mongoose.Schema.Types.Mixed,
    savedAddresses: [mongoose.Schema.Types.Mixed],
  },
  { collection: 'users' }
);

const User = mongoose.model('User', userSchema);

const INTERNAL_STAFF_ROLES = [
  'APPOINTMENT_AGENT',
  'SALES_STAFF',
  'ENGINEER',
  'CASHIER',
  'FABRICATION_STAFF',
  'ADMIN',
];

async function main() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log('✅ Connected to MongoDB\n');

    // Find all internal staff users with address data
    const query = {
      roles: { $in: INTERNAL_STAFF_ROLES },
      $or: [
        { addressData: { $ne: null } },
        { savedAddresses: { $ne: null } },
      ],
    };

    const affectedUsers = await User.find(query);
    console.log(`📊 Found ${affectedUsers.length} internal staff members with address data\n`);

    if (affectedUsers.length === 0) {
      console.log('✨ No addresses to clear\n');
      await mongoose.disconnect();
      process.exit(0);
    }

    // Show sample of affected users
    console.log('📋 Sample of affected users:');
    affectedUsers.slice(0, 5).forEach((user) => {
      console.log(
        `  • ${user.email} (${user.roles.join(', ')}): addressData=${user.addressData ? '✓' : '✗'}, savedAddresses=${user.savedAddresses?.length || 0} items`
      );
    });
    if (affectedUsers.length > 5) {
      console.log(`  ... and ${affectedUsers.length - 5} more\n`);
    } else {
      console.log('');
    }

    if (DRY_RUN) {
      console.log('🔍 DRY-RUN MODE: No changes will be made\n');
      await mongoose.disconnect();
      process.exit(0);
    }

    // Perform the update
    console.log('⏳ Clearing addresses...\n');
    const result = await User.updateMany(
      query,
      {
        $set: {
          addressData: null,
          savedAddresses: [],
        },
      }
    );

    console.log(`✅ Cleared addresses:`);
    console.log(`  • Matched: ${result.matchedCount} users`);
    console.log(`  • Modified: ${result.modifiedCount} users\n`);

    console.log('🎉 Migration complete!');
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
