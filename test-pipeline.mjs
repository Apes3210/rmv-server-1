/**
 * End-to-end pipeline test for the RMV System
 * Tests the full flow: Customer → Agent → Sales Staff → Engineer → Customer → Cashier → Fabricator
 */

import 'dotenv/config';

const BASE = 'http://localhost:5000/api/v1';
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL || process.env.SUPER_ADMIN_EMAIL || 'admin@rmvsteelfab.com';
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD || process.env.SUPER_ADMIN_PASSWORD || 'Admin@12345';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addBusinessDays(baseDate, businessDays) {
  const date = new Date(baseDate);
  let remaining = businessDays;
  while (remaining > 0) {
    date.setDate(date.getDate() + 1);
    if (date.getDay() !== 0 && date.getDay() !== 6) {
      remaining -= 1;
    }
  }
  return date;
}

// ── Helpers ──
async function request(method, path, body, cookies = {}) {
  const headers = { 'Content-Type': 'application/json' };
  
  // Build cookie string
  const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookieStr) headers['Cookie'] = cookieStr;

  if (cookies.accessToken) {
    headers.Authorization = `Bearer ${cookies.accessToken}`;
  }

  if (cookies.refreshToken) {
    headers['X-Refresh-Token'] = cookies.refreshToken;
  }
  
  // Add CSRF header
  if (cookies.csrfToken) headers['X-CSRF-Token'] = cookies.csrfToken;
  
  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, opts);
  
  // Parse set-cookie headers
  const setCookies = {};
  const rawCookies = res.headers.getSetCookie?.() || [];
  for (const c of rawCookies) {
    const [pair] = c.split(';');
    const [name, ...vals] = pair.split('=');
    setCookies[name.trim()] = vals.join('=').trim();
  }
  
  let data = null;
  try { data = await res.json(); } catch {}
  
  return { status: res.status, data, cookies: setCookies };
}

async function createSession() {
  const res = await request('GET', '/csrf-token');
  return { ...res.cookies };
}

async function login(email, password, _depth = 0) {
  if (_depth > 2) throw new Error(`Login recursion limit for ${email}`);
  
  const cookies = await createSession();
  const res = await request('POST', '/auth/login', { email, password }, cookies);
  
  // Handle rate limiting — wait and retry
  if (res.status === 429) {
    info(`Rate limited on login for ${email}, waiting 62s...`);
    await sleep(62000);
    return login(email, password, _depth); // Retry same depth after waiting
  }
  
  if (res.status !== 200) {
    // If login fails with wrong creds and we haven't tried the ! suffix, try it
    if (_depth === 0 && (res.data?.error?.code === 'INVALID_CREDENTIALS' || res.data?.error?.code === 'UNAUTHORIZED')) {
      return login(email, password + '!', _depth + 1);
    }
    // Rate limited or other error — just return the failure
    return { cookies, data: res.data, status: res.status };
  }
  
  // Merge cookies from login response
  Object.assign(cookies, res.cookies);
  if (res.data?.data?.csrfToken) {
    cookies.csrfToken = res.data.data.csrfToken;
  }
  if (res.data?.data?.accessToken) {
    cookies.accessToken = res.data.data.accessToken;
  }
  if (res.data?.data?.refreshToken) {
    cookies.refreshToken = res.data.data.refreshToken;
  }
  
  // Handle mustChangePassword
  if (res.data?.data?.user?.mustChangePassword) {
    const newPw = password + '!';
    const changePwRes = await request('POST', '/auth/change-password', {
      currentPassword: password,
      newPassword: newPw,
    }, cookies);
    
    if (changePwRes.status === 200) {
      info(`Password changed for ${email}`);
      return login(email, newPw, _depth + 1);
    }
  }
  
  return { cookies, data: res.data, status: res.status };
}

function log(icon, msg) { console.log(`${icon} ${msg}`); }
function pass(msg) { log('✅', msg); }
function fail(msg, detail) { log('❌', `${msg}: ${JSON.stringify(detail)}`); }
function info(msg) { log('ℹ️', msg); }
function section(msg) { console.log(`\n${'═'.repeat(60)}\n  ${msg}\n${'═'.repeat(60)}`); }

// ── Main Test ──
async function main() {
  let errors = [];
  
  // ━━━━━━━━━━━━ STEP 0: SETUP TEST USERS ━━━━━━━━━━━━
  section('STEP 0: Setup — Login as Admin & Create Test Users');
  
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (admin.status !== 200) {
    fail('Admin login failed', admin.data);
    return;
  }
  pass('Admin logged in');
  
  // Create test users (ignore if already exist)
  const testUsers = [
    { email: 'customer-test@example.com', password: 'Test@12345', firstName: 'Test', lastName: 'Customer', roles: ['customer'] },
    { email: 'agent-test@example.com', password: 'Test@12345', firstName: 'Test', lastName: 'Agent', roles: ['appointment_agent'] },
    { email: 'sales-test@example.com', password: 'Test@12345', firstName: 'Test', lastName: 'Sales', roles: ['sales_staff'] },
    { email: 'engineer-test@example.com', password: 'Test@12345', firstName: 'Test', lastName: 'Engineer', roles: ['engineer'] },
    { email: 'cashier-test@example.com', password: 'Test@12345', firstName: 'Test', lastName: 'Cashier', roles: ['cashier'] },
    { email: 'fabricator-test@example.com', password: 'Test@12345', firstName: 'Test', lastName: 'Fabricator', roles: ['fabrication_staff'] },
  ];
  
  const userIds = {};
  for (const u of testUsers) {
    const res = await request('POST', '/users/admin/users', u, admin.cookies);
    if (res.status === 201 || res.status === 200) {
      userIds[u.roles[0]] = res.data.data._id;
      pass(`Created ${u.roles[0]}: ${u.email}`);
    } else if (res.data?.error?.code === 'CONFLICT' || res.status === 409) {
      info(`${u.roles[0]} already exists, fetching ID...`);
      // Get user list to find ID
      const listRes = await request('GET', `/users/admin/users?role=${u.roles[0]}`, null, admin.cookies);
      const users = listRes.data?.data;
      if (Array.isArray(users) && users.length) {
        userIds[u.roles[0]] = users[0]._id;
        pass(`Found existing ${u.roles[0]}: ${userIds[u.roles[0]]}`);
      } else {
        fail(`Could not fetch ${u.roles[0]} user ID`, listRes.data);
      }
    } else {
      fail(`Failed to create ${u.roles[0]}`, res.data);
      errors.push(`create_${u.roles[0]}`);
    }
  }
  
  // ━━━━━━━━━━━━ STEP 1: CUSTOMER BOOKS APPOINTMENT ━━━━━━━━━━━━
  section('STEP 1: Customer Books an Appointment');
  
  const customer = await login('customer-test@example.com', 'Test@12345');
  if (customer.status !== 200) {
    fail('Customer login failed', customer.data);
    errors.push('customer_login');
  } else {
    pass('Customer logged in');
  }
  
  // First check if customer already has an active appointment
  const myApptsRes = await request('GET', '/appointments', null, customer.cookies);
  const existingAppts = myApptsRes.data?.data?.items || [];
  let appointmentId = null;
  
  // Cancel any active appointments so we start fresh
  for (const appt of existingAppts) {
    if (['requested', 'confirmed', 'reschedule_requested'].includes(appt.status)) {
      info(`Cancelling existing appointment ${appt._id} (status: ${appt.status})`);
      // Try customer cancel first, then admin cancel
      let cancelRes = await request('POST', `/appointments/${appt._id}/cancel`, { reason: 'Cleanup for E2E test' }, customer.cookies);
      if (cancelRes.status !== 200) {
        cancelRes = await request('POST', `/appointments/${appt._id}/cancel`, { reason: 'Cleanup for E2E test' }, admin.cookies);
      }
      if (cancelRes.status === 200) {
        pass(`Cancelled appointment ${appt._id}`);
      } else {
        info(`Cancel failed for ${appt._id}: ${cancelRes.status} - ${JSON.stringify(cancelRes.data?.error)}`);
      }
    }
  }
  
  // Book a new appointment — use a date 10 days from now to avoid slot conflicts
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 10);
  // Skip weekends
  if (futureDate.getDay() === 0) futureDate.setDate(futureDate.getDate() + 1);
  if (futureDate.getDay() === 6) futureDate.setDate(futureDate.getDate() + 2);
  const dateStr = formatLocalDate(futureDate);
  
  const slotsRes = await request('GET', `/appointments/slots?date=${dateStr}&type=office`, null, customer.cookies);
  info(`Slots for ${dateStr}: status=${slotsRes.status}`);
  if (slotsRes.data?.data) {
    const slotData = slotsRes.data.data;
    info(`Available slots: ${JSON.stringify(slotData).slice(0, 200)}...`);
  }
  
  const bookData = {
    date: dateStr,
    slotCode: '09:00',
    type: 'office',
    purpose: 'Site inspection for stainless steel railings',
  };
  
  const bookRes = await request('POST', '/appointments', bookData, customer.cookies);
  if (bookRes.status === 201) {
    appointmentId = bookRes.data?.data?._id;
    pass(`Appointment booked: ${appointmentId}`);
  } else {
    fail('Booking appointment failed', bookRes.data);
    errors.push('book_appointment');
  }
  
  // ━━━━━━━━━━━━ STEP 2: AGENT CONFIRMS + ASSIGNS SALES STAFF ━━━━━━━━━━━━
  let appointmentConfirmed = false;
  section('STEP 2: Agent Confirms Appointment & Assigns Sales Staff');
  
  const agent = await login('agent-test@example.com', 'Test@12345');
  if (agent.status !== 200) {
    fail('Agent login failed', agent.data);
    errors.push('agent_login');
  } else {
    pass('Agent logged in');
  }
  
  if (appointmentId) {
    // Check current status of the appointment
    const apptDetailRes = await request('GET', `/appointments/${appointmentId}`, null, agent.cookies);
    const apptStatus = apptDetailRes.data?.data?.status;
    info(`Appointment ${appointmentId} current status: ${apptStatus}`);
    
    if (apptStatus === 'requested') {
      // Use our test sales staff user ID (not the one from list endpoint which may return a different user)
      const salesStaffId = userIds.sales_staff;
      info(`Sales staff ID to assign: ${salesStaffId}`);
      
      const confirmRes = await request('POST', `/appointments/${appointmentId}/confirm`, {
        salesStaffId: salesStaffId
      }, agent.cookies);
      
      if (confirmRes.status === 200) {
        pass(`Appointment confirmed & sales staff assigned`);
        info(`Appointment status: ${confirmRes.data?.data?.status}`);
        appointmentConfirmed = true;
      } else {
        fail('Confirm appointment failed', confirmRes.data);
        errors.push('confirm_appointment');
      }
    } else if (apptStatus === 'confirmed') {
      info('Appointment already confirmed, skipping step 2');
      appointmentConfirmed = true;
    } else if (apptStatus === 'completed') {
      info('Appointment already completed, visit report should exist');
      appointmentConfirmed = true;
    } else {
      info(`Appointment in unexpected status: ${apptStatus}`);
    }
  }
  
  // ━━━━━━━━━━━━ STEP 3: SALES STAFF COMPLETES CONSULTATION REPORT ━━━━━━━━━━━━
  section('STEP 3: Sales Staff Completes Consultation Visit Report');
  
  const sales = await login('sales-test@example.com', 'Test@12345');
  if (sales.status !== 200) {
    fail('Sales Staff login failed', sales.data);
    errors.push('sales_login');
  } else {
    pass('Sales Staff logged in');
    info(`Sales cookies: ${Object.keys(sales.cookies).join(', ')}`);
  }
  
  // View their appointments
  const salesApptsRes = await request('GET', '/appointments?status=confirmed', null, sales.cookies);
  info(`Sales staff confirmed appointments: ${salesApptsRes.status} - ${salesApptsRes.data?.data?.items?.length ?? JSON.stringify(salesApptsRes.data).slice(0,200)}`);
  
  // Check visit report was auto-created
  let visitReportId = null;
  if (appointmentId && appointmentConfirmed) {
    const vrRes = await request('GET', `/visit-reports/appointment/${appointmentId}`, null, sales.cookies);
    const reports = Array.isArray(vrRes.data?.data) ? vrRes.data.data : vrRes.data?.data ? [vrRes.data.data] : [];
    const consultationReport = reports.find((report) => report.visitType === 'consultation') || reports[0];

    if (vrRes.status === 200 && consultationReport?._id) {
      visitReportId = consultationReport._id;
      pass(`Visit report auto-created: ${visitReportId} (status: ${consultationReport.status})`);
    } else {
      fail('Visit report not found for appointment', vrRes.data);
      errors.push('auto_create_visit_report');
    }
  } else if (appointmentId && !appointmentConfirmed) {
    info('Skipping visit report check because appointment was not confirmed');
    errors.push('appointment_not_confirmed');
  }
  
  // Fill in visit report
  if (visitReportId) {
    const recommendedOcularDate = formatLocalDate(addBusinessDays(futureDate, 3));
    const updateVrRes = await request('PUT', `/visit-reports/${visitReportId}`, {
      visitType: 'consultation',
      actualVisitDateTime: new Date().toISOString(),
      serviceType: 'door',
      productsDiscussed: 'Custom stainless steel framed door with tempered glass inserts',
      designPreferences: 'Modern minimalist frame with brushed finish and clear glass',
      materialOptions: 'Stainless Steel 304, tempered glass, concealed hardware',
      projectScope: 'Measure and fabricate one main door with side panel detailing',
      materials: 'Stainless Steel 304, Tempered Glass',
      finishes: 'Brushed Finish',
      preferredDesign: 'Modern minimalist with glass panels',
      customerRequirements: 'Customer wants a custom stainless door for the main entrance with a matching side panel.',
      notes: 'Consultation completed in office. Customer approved ocular follow-up for site measurements.',
      recommendedOcularDate: new Date(`${recommendedOcularDate}T13:00:00+08:00`).toISOString(),
      recommendedOcularSlot: '13:00',
    }, sales.cookies);
    
    if (updateVrRes.status === 200) {
      pass('Consultation visit report updated');
    } else {
      fail('Update visit report failed', updateVrRes.data);
      errors.push('update_visit_report');
    }

    const completeConsultationRes = await request('POST', `/appointments/${appointmentId}/complete`, null, sales.cookies);
    if (completeConsultationRes.status === 200) {
      pass(`Consultation appointment completed (status: ${completeConsultationRes.data?.data?.status})`);
    } else {
      fail('Complete consultation appointment failed', completeConsultationRes.data);
      errors.push('complete_consultation_appointment');
    }

    // Submit visit report (creates draft project and an ocular follow-up request)
    const submitVrRes = await request('POST', `/visit-reports/${visitReportId}/submit`, null, sales.cookies);
    if (submitVrRes.status === 200) {
      pass(`Consultation visit report submitted (status: ${submitVrRes.data?.data?.status})`);
    } else {
      fail('Submit visit report failed', submitVrRes.data);
      errors.push('submit_visit_report');
    }
  }
  
  // ━━━━━━━━━━━━ STEP 4: CHECK AUTO-CREATED PROJECT ━━━━━━━━━━━━
  section('STEP 4: Verify Draft Project from Consultation');
  
  // The project should have been auto-created on visit report submit
  // Use admin cookies to see all projects
  const projectsRes = await request('GET', '/projects', null, admin.cookies);
  info(`Total projects: ${projectsRes.data?.data?.items?.length || projectsRes.data?.data?.length || 0}`);
  
  let projectId = null;
  const projectList = projectsRes.data?.data?.items || projectsRes.data?.data || [];
  if (Array.isArray(projectList) && projectList.length > 0 && appointmentId) {
    // Find the project linked to THIS appointment only.
    const matchingProject = projectList.find(p => p.appointmentId?.toString() === appointmentId);
    if (matchingProject) {
      projectId = matchingProject._id;
      pass(`Project found: ${projectId} (status: ${matchingProject.status}, title: ${matchingProject.title})`);
    } else {
      fail('No project linked to the newly created appointment', { appointmentId });
      errors.push('auto_create_project');
    }
  } else if (!appointmentId) {
    fail('Cannot locate project because appointment was not created');
    errors.push('no_appointment_for_project_lookup');
  } else {
    fail('No projects found after visit report submission');
    errors.push('auto_create_project');
  }

  // ━━━━━━━━━━━━ STEP 5: OCULAR FOLLOW-UP FLOW ━━━━━━━━━━━━
  section('STEP 5: Ocular Follow-Up (Location, Fee, Finalize, Report)');

  let ocularAppointmentId = null;
  if (projectId) {
    const customerAppointmentsRes = await request('GET', '/appointments', null, customer.cookies);
    const customerAppointments = customerAppointmentsRes.data?.data?.items || [];
    const ocularAppointment = customerAppointments.find((appt) => appt.type === 'ocular');

    if (ocularAppointment?._id) {
      ocularAppointmentId = ocularAppointment._id;
      pass(`Ocular appointment available: ${ocularAppointmentId} (status: ${ocularAppointment.status})`);
    } else {
      fail('No ocular appointment was created from the consultation flow', customerAppointmentsRes.data);
      errors.push('auto_create_ocular');
    }
  }

  if (ocularAppointmentId) {
    const submitLocationRes = await request('POST', `/appointments/${ocularAppointmentId}/submit-location`, {
      customerLocation: {
        lat: 16.4023,
        lng: 120.596,
      },
      formattedAddress: 'Session Road, Baguio City, Benguet, Philippines',
      addressStructured: {
        street: 'Session Road',
        barangay: 'Session Road Area',
        city: 'Baguio City',
        province: 'Benguet',
        zip: '2600',
      },
    }, customer.cookies);

    if (submitLocationRes.status === 200) {
      pass(`Customer submitted ocular location (fee: ${submitLocationRes.data?.data?.ocularFee ?? 'n/a'})`);
    } else {
      fail('Submit ocular location failed', submitLocationRes.data);
      errors.push('submit_ocular_location');
    }

    const simulateOcularPaymentRes = await request('POST', `/appointments/${ocularAppointmentId}/simulate-ocular-payment`, null, customer.cookies);
    if (simulateOcularPaymentRes.status === 200) {
      pass('Ocular fee simulated successfully');
    } else {
      fail('Simulate ocular fee payment failed', simulateOcularPaymentRes.data);
      errors.push('simulate_ocular_payment');
    }

    const finalizeOcularRes = await request('POST', `/appointments/${ocularAppointmentId}/finalize-ocular`, {
      internalNotes: 'Smoke test finalized after customer submitted location and payment.',
    }, sales.cookies);
    if (finalizeOcularRes.status === 200) {
      pass(`Ocular appointment finalized (status: ${finalizeOcularRes.data?.data?.status})`);
    } else {
      fail('Finalize ocular appointment failed', finalizeOcularRes.data);
      errors.push('finalize_ocular');
    }

    const completeOcularRes = await request('POST', `/appointments/${ocularAppointmentId}/complete`, null, sales.cookies);
    if (completeOcularRes.status === 200) {
      pass(`Ocular appointment completed (status: ${completeOcularRes.data?.data?.status})`);
    } else {
      fail('Complete ocular appointment failed', completeOcularRes.data);
      errors.push('complete_ocular_appointment');
    }

    const ocularVrRes = await request('GET', `/visit-reports/appointment/${ocularAppointmentId}`, null, sales.cookies);
    const ocularReports = Array.isArray(ocularVrRes.data?.data) ? ocularVrRes.data.data : ocularVrRes.data?.data ? [ocularVrRes.data.data] : [];
    const ocularReport = ocularReports.find((report) => report.visitType === 'ocular') || ocularReports[0];
    const ocularVisitReportId = ocularReport?._id || null;

    if (ocularVisitReportId) {
      pass(`Ocular visit report auto-created: ${ocularVisitReportId} (status: ${ocularReport.status})`);

      const updateOcularVrRes = await request('PUT', `/visit-reports/${ocularVisitReportId}`, {
        visitType: 'ocular',
        actualVisitDateTime: new Date().toISOString(),
        measurementUnit: 'cm',
        lineItems: [
          {
            label: 'Main entrance door frame',
            length: 210,
            width: 95,
            height: 210,
            area: 19950,
            thickness: 3,
            quantity: 1,
            notes: 'Measured from finished floor to top lintel; frame opening confirmed on site.',
          },
        ],
        siteConditions: {
          environment: 'outdoor',
          floorType: 'concrete',
          wallMaterial: 'reinforced concrete',
          hasElectrical: true,
          hasPlumbing: false,
          accessNotes: 'Front entrance is accessible through the main gate with clear unloading access.',
          obstaclesOrConstraints: 'Work area is near existing glass panels and requires edge protection.',
        },
        materials: 'Stainless Steel 304 with tempered glass infill',
        finishes: 'Brushed finish',
        preferredDesign: 'Modern minimalist glass door with slim stainless framing',
        customerRequirements: 'Customer requested child-safe clearances and a concealed closer.',
        notes: 'Final site measurements captured and confirmed with the customer during ocular visit.',
        photoKeys: ['site-photos/ocular-1.jpg'],
        initialDesignKeys: ['initial-designs/ocular-sketch-1.pdf'],
        initialDesignNotes: 'Initial ocular sketch prepared on site for engineer turnover.',
        linkedProjectId: projectId,
      }, sales.cookies);

      if (updateOcularVrRes.status === 200) {
        pass('Ocular visit report updated with site measurements');
      } else {
        fail('Update ocular visit report failed', updateOcularVrRes.data);
        errors.push('update_ocular_visit_report');
      }

      const submitOcularVrRes = await request('POST', `/visit-reports/${ocularVisitReportId}/submit`, null, sales.cookies);
      if (submitOcularVrRes.status === 200) {
        pass(`Ocular visit report submitted (status: ${submitOcularVrRes.data?.data?.status})`);
      } else {
        fail('Submit ocular visit report failed', submitOcularVrRes.data);
        errors.push('submit_ocular_visit_report');
      }

      const projectAfterOcularRes = await request('GET', `/projects/${projectId}`, null, admin.cookies);
      const projectStatusAfterOcular = projectAfterOcularRes.data?.data?.status;
      info(`Project status after ocular report: ${projectStatusAfterOcular}`);
      if (projectStatusAfterOcular === 'submitted') {
        pass('Project is engineer-ready after ocular submission');
      } else {
        fail('Project did not reach submitted status after ocular report', projectAfterOcularRes.data);
        errors.push('project_not_submitted_after_ocular');
      }
    } else {
      fail('Ocular visit report not found for follow-up appointment', ocularVrRes.data);
      errors.push('auto_create_ocular_visit_report');
    }
  }
  
  // ━━━━━━━━━━━━ STEP 5: ENGINEER ASSIGNS + CREATES BLUEPRINT ━━━━━━━━━━━━
  section('STEP 6: Engineer Reviews, Creates Blueprint & Quotation');
  
  const engineer = await login('engineer-test@example.com', 'Test@12345');
  if (engineer.status !== 200) {
    fail('Engineer login failed', engineer.data);
    errors.push('engineer_login');
  } else {
    pass('Engineer logged in');
  }
  
  if (projectId) {
    // Admin assigns engineer to the project
    const engineerId = userIds.engineer || engineer.data?.data?.user?._id;
    const assignRes = await request('POST', `/projects/${projectId}/assign-engineers`, {
      engineerIds: [engineerId]
    }, admin.cookies);
    
    if (assignRes.status === 200) {
      pass(`Engineer assigned to project (status: ${assignRes.data?.data?.status})`);
    } else {
      fail('Assign engineer failed', assignRes.data);
      errors.push('assign_engineer');
    }

    const reviewInitialDesignRes = await request('POST', `/projects/${projectId}/review-initial-design`, {
      decision: 'approved',
      notes: 'Initial sales design package is sufficient for blueprint preparation.',
    }, engineer.cookies);

    if (reviewInitialDesignRes.status === 200) {
      pass('Engineer approved the initial design package');
    } else {
      fail('Engineer initial design review failed', reviewInitialDesignRes.data);
      errors.push('review_initial_design');
    }

    const signEngineerContractRes = await request('POST', `/projects/${projectId}/sign-contract-engineer`, {
      signatureKey: 'signatures/engineer-smoke-signature.png',
    }, engineer.cookies);

    if (signEngineerContractRes.status === 200) {
      pass('Engineer contract signed');
    } else {
      fail('Engineer contract signing failed', signEngineerContractRes.data);
      errors.push('sign_engineer_contract');
    }
    
    // Upload blueprint with quotation (needs blueprintKey + designKey + costingKey)
    const blueprintRes = await request('POST', `/blueprints`, {
      projectId: projectId,
      blueprintKey: 'blueprints/test-blueprint.pdf',
      designKey: 'blueprints/test-design.pdf',
      costingKey: 'blueprints/test-costing.pdf',
      quotation: {
        materials: 45000,
        labor: 25000,
        fees: 5000,
        total: 75000,
        breakdown: 'SS304 tubing, tempered glass panels, mounting hardware',
        estimatedDuration: '14 working days',
        engineerNotes: 'Standard installation. No welding on-site required.',
      }
    }, engineer.cookies);
    
    if (blueprintRes.status === 201 || blueprintRes.status === 200) {
      pass(`Blueprint uploaded with quotation: ${blueprintRes.data?.data?._id}`);
    } else {
      fail('Blueprint upload failed', blueprintRes.data);
      errors.push('upload_blueprint');
    }
  }
  
  // ━━━━━━━━━━━━ STEP 6: CUSTOMER REVIEWS & ACCEPTS BLUEPRINT ━━━━━━━━━━━━
  section('STEP 7: Customer Reviews & Accepts Blueprint');
  
  if (projectId) {
    // Get blueprints for this project (use /blueprints/project/:projectId)
    const bpListRes = await request('GET', `/blueprints/project/${projectId}`, null, customer.cookies);
    const bpList = bpListRes.data?.data;
    const bpCount = Array.isArray(bpList) ? bpList.length : bpList?.items?.length || 0;
    info(`Blueprints for project: ${bpCount}`);
    
    let blueprintId = null;
    if (Array.isArray(bpList) && bpList.length > 0) {
      blueprintId = bpList[0]._id;
      info(`Blueprint ID: ${blueprintId}, status: ${bpList[0].status}`);
    } else if (bpList?.items?.length > 0) {
      blueprintId = bpList.items[0]._id;
      info(`Blueprint ID: ${blueprintId}, status: ${bpList.items[0].status}`);
    }
    
    if (blueprintId) {
      // Customer approves blueprint component
      const approveBpRes = await request('POST', `/blueprints/${blueprintId}/approve`, {
        component: 'blueprint'
      }, customer.cookies);
      if (approveBpRes.status === 200) {
        pass(`Blueprint drawing approved by customer (status: ${approveBpRes.data?.data?.status})`);
      } else {
        fail('Blueprint approval failed', approveBpRes.data);
        errors.push('approve_blueprint');
      }
      
      // Customer approves costing component
      const approveCostRes = await request('POST', `/blueprints/${blueprintId}/approve`, {
        component: 'costing'
      }, customer.cookies);
      if (approveCostRes.status === 200) {
        pass(`Costing approved by customer (status: ${approveCostRes.data?.data?.status})`);
      } else {
        info(`Costing approval: ${approveCostRes.status} - ${JSON.stringify(approveCostRes.data?.error)}`);
      }
      
      // Check project status should now be APPROVED
      const projectCheck = await request('GET', `/projects/${projectId}`, null, admin.cookies);
      info(`Project status after approvals: ${projectCheck.data?.data?.status}`);
    }
  }
  
  // ━━━━━━━━━━━━ STEP 7: PAYMENT PLAN CREATION & FIRST PAYMENT ━━━━━━━━━━━━
  let projectInFabrication = false;
  section('STEP 8: Payment Plan & Stage Payments');
  
  if (projectId) {
    const cashier = await login('cashier-test@example.com', 'Test@12345');
    if (cashier.status !== 200) {
      fail('Cashier login failed', cashier.data);
      errors.push('cashier_login');
    } else {
      pass('Cashier logged in');
    }

    const projBeforePlan = await request('GET', `/projects/${projectId}`, null, admin.cookies);
    const projectStatusBeforePlan = projBeforePlan.data?.data?.status;
    info(`Project status before payment plan: ${projectStatusBeforePlan}`);
    if (projectStatusBeforePlan !== 'approved') {
      fail('Project is not in approved state for payment plan creation', {
        projectStatusBeforePlan,
      });
      errors.push('project_not_approved_for_payment');
    } else {
      const selectPlanRes = await request('POST', `/projects/${projectId}/select-payment-plan`, {
        paymentType: 'installment',
      }, customer.cookies);

      if (selectPlanRes.status === 200) {
        pass('Customer selected installment payment plan');
      } else {
        fail('Customer payment plan selection failed', selectPlanRes.data);
        errors.push('select_payment_plan');
      }

      const signContractRes = await request('POST', `/projects/${projectId}/sign-contract`, {
        signatureKey: 'signatures/customer-smoke-signature.png',
      }, customer.cookies);

      if (signContractRes.status === 200) {
        pass('Customer contract signed');
      } else {
        fail('Customer contract signing failed', signContractRes.data);
        errors.push('sign_customer_contract');
      }

      const projAfterPlan = await request('GET', `/projects/${projectId}`, null, admin.cookies);
      info(`Project status after payment plan + contract: ${projAfterPlan.data?.data?.status}`);

      // Get payment plan to see stage IDs
      const planRes = await request('GET', `/payments/plan/${projectId}`, null, customer.cookies);
      info(`Payment plan stages: ${planRes.data?.data?.stages?.length || 0}`);

      const plan = planRes.data?.data;
      const stages = plan?.stages || [];

      if (stages.length > 0) {
        const firstStage = stages[0];
        const firstStageId = firstStage.stageId || firstStage._id;
        info(`Processing initial payment stage: ${firstStageId} (${firstStage.percentage}%, ${firstStage.amount})`);

        const proofRes = await request('POST', `/payments/stages/${firstStageId}/simulate`, null, customer.cookies);

        if (proofRes.status === 200 || proofRes.status === 201) {
          pass('Payment proof submitted for initial stage');
          const paymentId = proofRes.data?.data?.payment?._id;

          if (paymentId) {
            const verifyRes = await request('POST', `/payments/${paymentId}/verify`, {
              signatureKey: 'signatures/cashier-smoke-signature.png',
            }, cashier.cookies);
            if (verifyRes.status === 200) {
              pass('Initial payment stage verified by cashier');
            } else {
              fail('Verify initial payment stage failed', verifyRes.data);
              errors.push('verify_payment_1');
            }
          } else {
            fail('Simulated payment did not return a payment ID', proofRes.data);
            errors.push('missing_payment_id');
          }
        } else {
          fail('Submit payment proof for initial stage failed', proofRes.data);
          errors.push('submit_proof_1');
        }

        const projAfterPayments = await request('GET', `/projects/${projectId}`, null, admin.cookies);
        const projectStatusAfterPayments = projAfterPayments.data?.data?.status;
        info(`Project status after first payment verification: ${projectStatusAfterPayments}`);
        if (projectStatusAfterPayments === 'fabrication') {
          projectInFabrication = true;
        } else {
          fail('Project did not enter fabrication after first verified payment', projAfterPayments.data);
          errors.push('project_not_in_fabrication_after_payment');
        }
      } else {
        info('No stages found in payment plan');
        errors.push('no_stages');
      }
    }
  }
  
  // ━━━━━━━━━━━━ STEP 8: FABRICATION FLOW ━━━━━━━━━━━━
  section('STEP 9: Fabrication Flow');
  
  const fabricator = await login('fabricator-test@example.com', 'Test@12345');
  if (fabricator.status !== 200) {
    fail('Fabricator login failed', fabricator.data);
    errors.push('fabricator_login');
  } else {
    pass('Fabricator logged in');
  }
  
  if (projectId && projectInFabrication) {
    // Check project status
    const projCheck = await request('GET', `/projects/${projectId}`, null, admin.cookies);
    info(`Project status before fabrication: ${projCheck.data?.data?.status}`);
    
    // Assign fabrication staff to project
    const fabAssignRes = await request('POST', `/projects/${projectId}/assign-fabrication`, {
      fabricationLeadId: userIds.fabrication_staff || fabricator.data?.data?.user?._id,
      fabricationAssistantIds: [],
    }, admin.cookies);
    if (fabAssignRes.status === 200) {
      pass(`Fabrication staff assigned (status: ${fabAssignRes.data?.data?.status})`);
    } else {
      info(`Fab assign: ${fabAssignRes.status} - ${JSON.stringify(fabAssignRes.data?.error)}`);
    }
    
    // Each fabrication stage = a new POST /fabrication (no transition endpoint)
    // Check current fabrication status first
    const fabStatusRes = await request('GET', `/fabrication/project/${projectId}/status`, null, fabricator.cookies);
    const currentFabStatus = fabStatusRes.data?.data?.status;
    info(`Current fabrication status: ${currentFabStatus || 'none'}`);
    
    const allStages = ['queued', 'material_prep', 'cutting', 'welding', 'assembly', 'finishing', 'quality_check', 'ready_for_delivery', 'done'];
    // When no updates exist, current status defaults to 'queued', so skip it
    // Also skip stages already completed
    const effectiveStatus = currentFabStatus || 'queued';
    const startIdx = Math.max(allStages.indexOf(effectiveStatus) + 1, 1); // always start at material_prep minimum
    const stages = allStages.slice(startIdx);

    async function settleNextPaymentStage(triggerStage) {
      const latestPlanRes = await request('GET', `/payments/plan/${projectId}`, null, customer.cookies);
      const latestStages = latestPlanRes.data?.data?.stages || [];
      const unpaidStage = latestStages.find((stage) => stage.status !== 'verified');

      if (!unpaidStage) {
        fail(`No unpaid payment stage available to clear fabrication gate at ${triggerStage}`, latestPlanRes.data);
        errors.push(`missing_payment_gate_stage_${triggerStage}`);
        return false;
      }

      const gateStageId = unpaidStage.stageId || unpaidStage._id;
      info(`Clearing fabrication gate for ${triggerStage} via payment stage ${unpaidStage.label} (${gateStageId})`);

      const proofRes = await request('POST', `/payments/stages/${gateStageId}/simulate`, null, customer.cookies);
      if (proofRes.status !== 200 && proofRes.status !== 201) {
        fail(`Submit payment proof for fabrication gate (${triggerStage}) failed`, proofRes.data);
        errors.push(`submit_proof_gate_${triggerStage}`);
        return false;
      }

      const paymentId = proofRes.data?.data?.payment?._id;
      if (!paymentId) {
        fail(`Fabrication gate payment for ${triggerStage} did not return a payment ID`, proofRes.data);
        errors.push(`missing_payment_id_gate_${triggerStage}`);
        return false;
      }

      const verifyRes = await request('POST', `/payments/${paymentId}/verify`, {
        signatureKey: 'signatures/admin-smoke-signature.png',
      }, admin.cookies);

      if (verifyRes.status === 200) {
        pass(`Payment gate cleared for fabrication stage ${triggerStage}`);
        return true;
      }

      fail(`Verify payment for fabrication gate (${triggerStage}) failed`, verifyRes.data);
      errors.push(`verify_payment_gate_${triggerStage}`);
      return false;
    }
    
    for (const stage of stages) {
      let fabRes = await request('POST', '/fabrication', {
        projectId: projectId,
        status: stage,
        notes: `Stage update: ${stage}`,
        photoKeys: ['fabrication/stage-photo.jpg'],
      }, fabricator.cookies);
      
      if (fabRes.status === 201 || fabRes.status === 200) {
        pass(`Fabrication → ${stage}`);
      } else {
        const fabErrorCode = fabRes.data?.error?.code;

        if (fabErrorCode === 'FABRICATION_PAYMENT_GATE') {
          const gateCleared = await settleNextPaymentStage(stage);
          if (gateCleared) {
            fabRes = await request('POST', '/fabrication', {
              projectId: projectId,
              status: stage,
              notes: `Stage update: ${stage}`,
              photoKeys: ['fabrication/stage-photo.jpg'],
            }, fabricator.cookies);
          }
        } else if (fabErrorCode === 'FABRICATION_INSTALLATION_NOT_CONFIRMED') {
          const confirmInstallRes = await request('POST', `/projects/${projectId}/confirm-installation`, null, customer.cookies);
          if (confirmInstallRes.status === 200) {
            pass('Customer confirmed installation schedule');
            fabRes = await request('POST', '/fabrication', {
              projectId: projectId,
              status: stage,
              notes: `Stage update: ${stage}`,
              photoKeys: ['fabrication/stage-photo.jpg'],
            }, fabricator.cookies);
          } else {
            fail('Customer installation confirmation failed', confirmInstallRes.data);
            errors.push('confirm_installation');
          }
        }

        if (fabRes.status === 201 || fabRes.status === 200) {
          pass(`Fabrication → ${stage}`);
        } else {
          fail(`Fabrication ${stage} failed`, fabRes.data);
          errors.push(`fab_${stage}`);
          break;
        }
      }
    }
    
    // Final project status check
    const finalProj = await request('GET', `/projects/${projectId}`, null, admin.cookies);
    info(`Final project status: ${finalProj.data?.data?.status}`);
    if (finalProj.data?.data?.status === 'completed') {
      pass('Project reached completed status after fabrication flow');
    } else {
      errors.push('project_not_completed');
    }
  } else if (projectId && !projectInFabrication) {
    info('Skipping fabrication flow because project is not yet in fabrication status');
    errors.push('project_not_in_fabrication');
  }
  
  // ━━━━━━━━━━━━ RESULTS ━━━━━━━━━━━━
  section('TEST RESULTS');
  if (errors.length === 0) {
    pass('ALL PIPELINE TESTS PASSED! 🎉');
  } else {
    fail(`${errors.length} step(s) had issues: ${errors.join(', ')}`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
