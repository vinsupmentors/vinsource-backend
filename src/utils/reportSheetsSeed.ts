/**
 * Seed content for the "BRD Tracker" spreadsheet — the five sheets the team kept in Google Sheets.
 * Values are plain text (no formulas); colours are copied from the originals.
 */
export interface Cell { v: string; bg?: string; fg?: string; b?: 1; i?: 1; al?: 'l' | 'c' | 'r' }
export interface Merge { r: number; c: number; rs: number; cs: number }
export interface SheetContent { rows: number; cols: number; colWidths: number[]; rowHeights: Record<string, number>; merges: Merge[]; cells: Record<string, Cell>; frozenRows: number }

class G {
  cells: Record<string, Cell> = {};
  merges: Merge[] = [];
  rowHeights: Record<string, number> = {};
  constructor(public colWidths: number[], public frozenRows = 0) {}
  set(r: number, c: number, v: string | number, st: Omit<Cell, 'v'> = {}) { this.cells[`${r},${c}`] = { v: String(v), ...st }; }
  merge(r: number, c: number, rs: number, cs: number) { this.merges.push({ r, c, rs, cs }); }
  /** Fill a styled blank across a merged / empty range so the colour shows. */
  fill(r: number, c: number, rs: number, cs: number, st: Omit<Cell, 'v'>) {
    for (let i = r; i < r + rs; i++) for (let j = c; j < c + cs; j++) if (!this.cells[`${i},${j}`]) this.cells[`${i},${j}`] = { v: '', ...st };
  }
  build(usedRows: number, usedCols: number): SheetContent {
    return { rows: usedRows + 20, cols: Math.max(usedCols + 2, 10), colWidths: this.colWidths, rowHeights: this.rowHeights, merges: this.merges, cells: this.cells, frozenRows: this.frozenRows };
  }
}

const WHITE = '#ffffff', BLACK = '#000000';
const heat = (pct: number) => (pct >= 100 ? '#57bb8a' : pct >= 50 ? '#b7cf6e' : pct >= 25 ? '#f6b26b' : '#e67c73');

// ── 1. Booked VS Conducted ──────────────────────────────────────────────
function bookedVsConducted(): SheetContent {
  const g = new G([140, 130, 62, 80, 80, 80, 80, 60, 82, 62, 120, 100, 80, 80, 60, 82, 62, 120, 100]);
  const Y = '#ffff00';
  g.set(1, 0, 'Start Date', { bg: Y, b: 1 }); g.set(1, 1, '10/28/2026', { bg: Y, al: 'c' }); g.set(1, 2, '0', { al: 'c' });
  g.set(2, 0, 'End Date', { bg: Y, b: 1 }); g.set(2, 1, '10/28/2026', { bg: Y, al: 'c' }); g.set(2, 2, '1', { al: 'c' });
  g.set(1, 5, 'Demo Fixed Vs Conducted', { bg: '#45b8c4', fg: BLACK, b: 1, al: 'c' }); g.merge(1, 5, 1, 14); g.fill(1, 5, 1, 14, { bg: '#45b8c4' });
  g.set(2, 5, 'Online', { bg: '#00ffff', b: 1, al: 'c' }); g.merge(2, 5, 1, 7); g.fill(2, 5, 1, 7, { bg: '#00ffff' });
  g.set(2, 12, 'Offline', { bg: '#d5a6bd', b: 1, al: 'c' }); g.merge(2, 12, 1, 7); g.fill(2, 12, 1, 7, { bg: '#d5a6bd' });
  const OR = '#ff6d00', BL = '#4a90e2', BG = '#ffe599';
  ['Advisor', 'TL', 'Target', 'Demo Over', 'Acheived'].forEach((t, i) => g.set(3, i, t, { bg: OR, fg: WHITE, b: 1, al: 'c' }));
  ['Demo Fixed', 'Demo Over', '%'].forEach((t, i) => g.set(3, 5 + i, t, { bg: BL, fg: WHITE, b: 1, al: 'c' }));
  ['Interested', '50 - 50', 'Need to Followup', 'Not Interested'].forEach((t, i) => g.set(3, 8 + i, t, { bg: BG, b: 1, al: 'c' }));
  ['Demo Fixed', 'Demo Over', '%'].forEach((t, i) => g.set(3, 12 + i, t, { bg: '#f6b26b', b: 1, al: 'c' }));
  ['Interested', '50 - 50', 'Need to Followup', 'Not Interested'].forEach((t, i) => g.set(3, 15 + i, t, { bg: BG, b: 1, al: 'c' }));

  type Row = [string, string, number, number, string, (number | string)[], (number | string)[]];
  const rows: Row[] = [
    ['Muhammed Ramees J', 'Kumaresan', 2, 2, '100%', [2, 1, '50%', 0, 1, 0, 0], [1, 1, '100%', 1, 0, 0, 0]],
    ['Pradhap M', 'Pradhap M', 2, 2, '100%', [2, 0, '0%', 0, 0, 0, 0], [2, 2, '100%', 0, 2, 0, 0]],
    ['Hariharen A', 'Hariharen A', 2, 1, '50%', [0, 0, '0%', 0, 0, 0, 0], [1, 1, '100%', 1, 0, 0, 0]],
    ['Jothi Malar S', 'Hariharen A', 2, 1, '50%', [2, 0, '0%', 0, 0, 0, 0], [1, 1, '100%', 1, 0, 0, 0]],
    ['Hariharasudhan', 'Kumaresan', 2, 1, '50%', [1, 0, '0%', 0, 0, 0, 0], [1, 1, '100%', 1, 0, 0, 0]],
    ['Nisha Banu', 'Direct Reporting', 2, 0, '0%', [0, 0, '0%', 0, 0, 0, 0], [0, 0, '0%', 0, 0, 0, 0]],
    ['Kumaresan', 'Kumaresan', 2, 0, '0%', [1, 0, '0%', 0, 0, 0, 0], [1, 0, '0%', 0, 0, 0, 0]],
    ['Ranjith', 'Pradhap M', 2, 0, '0%', [1, 0, '0%', 0, 0, 0, 0], [0, 0, '0%', 0, 0, 0, 0]],
    ['Shabir Ahmed S', 'Pradhap M', 2, 0, '0%', [3, 0, '0%', 0, 0, 0, 0], [0, 0, '0%', 0, 0, 0, 0]],
    ['Vishmitha V', 'Pradhap M', 2, 0, '0%', [0, 0, '0%', 0, 0, 0, 0], [0, 0, '0%', 0, 0, 0, 0]],
  ];
  const tl: Row[] = [
    ['', 'Hariharen A', 4, 2, '50%', [2, 0, '0%', 0, 0, 0, 0], [2, 2, '100%', 2, 0, 0, 0]],
    ['', 'Kumaresan', 6, 3, '50%', [4, 1, '25%', 0, 1, 0, 0], [3, 2, '67%', 2, 0, 0, 0]],
    ['', 'Pradhap M', 8, 2, '25%', [6, 0, '0%', 0, 0, 0, 0], [2, 2, '100%', 0, 2, 0, 0]],
    ['', 'Direct Reporting', 2, 0, '0%', [0, 0, '0%', 0, 0, 0, 0], [0, 0, '0%', 0, 0, 0, 0]],
  ];
  const put = (r: number, row: Row, isTl: boolean) => {
    if (!isTl) g.set(r, 0, row[0]);
    g.set(r, 1, row[1], { al: 'c' }); g.set(r, 2, row[2], { al: 'c' }); g.set(r, 3, row[3], { al: 'c' });
    g.set(r, 4, row[4], { al: 'c', bg: heat(parseInt(row[4], 10)) });
    const on = isTl ? '#c9daf8' : undefined, off = isTl ? '#fff2cc' : undefined;
    row[5].forEach((v, i) => g.set(r, 5 + i, v, { al: 'c', bg: !isTl && i < 2 && Number(v) > 0 ? '#b6d7a8' : on }));
    row[6].forEach((v, i) => g.set(r, 12 + i, v, { al: 'c', bg: !isTl && i < 2 && Number(v) > 0 ? '#b6d7a8' : off }));
  };
  rows.forEach((row, i) => put(4 + i, row, false));
  tl.forEach((row, i) => put(14 + i, row, true));
  g.set(14, 0, 'Demo', { bg: '#00ffff', al: 'c', b: 1 }); g.merge(14, 0, 4, 1); g.fill(14, 0, 4, 1, { bg: '#00ffff' });
  const tot: (number | string)[] = [20, 7, '125%', 12, 1, '8%', 0, 1, 0, 0, 7, 6, '86%', 4, 2, 0, 0];
  tot.forEach((v, i) => g.set(18, 2 + i, v, { bg: '#ea4335', fg: WHITE, b: 1, al: 'c' }));
  g.set(22, 8, 19, { bg: '#57bb8a', al: 'c', b: 1 }); g.set(22, 9, 7, { bg: '#57bb8a', al: 'c', b: 1 });
  return g.build(24, 19);
}

// ── 2. Booking ─────────────────────────────────────────────────────────
function booking(): SheetContent {
  const g = new G([140, 130, 70, 90, 160, 80, 100]);
  const B = '#a4c2f4';
  g.set(1, 0, 'Start Date', { bg: B, b: 1, al: 'c' }); g.set(1, 1, '10/28/2026', { bg: B, al: 'c' }); g.set(1, 2, '0', { al: 'c' });
  g.set(2, 0, 'End Date', { bg: B, b: 1, al: 'c' }); g.set(2, 1, '10/28/2026', { bg: B, al: 'c' }); g.set(2, 2, '1', { al: 'c', bg: '#f4cccc' });
  g.set(2, 3, 'Bookings', { bg: '#45b8c4', b: 1, al: 'c' }); g.merge(2, 3, 1, 4); g.fill(2, 3, 1, 4, { bg: '#45b8c4' });
  const H = '#d0e0e3';
  ['BDA', 'TL', 'Target', 'Fresh Booking', 'Demo Day\nM | T | W |T |F |S |S', 'Booking Avg', 'Rescheduled Booking'].forEach((t, i) => g.set(3, i, t, { bg: H, b: 1, al: 'c' }));
  g.rowHeights['3'] = 44;
  const heat2 = (v: number) => (v >= 1 ? '#57bb8a' : v >= 0.6 ? '#b7cf6e' : v >= 0.4 ? '#ffd966' : v >= 0.2 ? '#f6b26b' : '#e67c73');
  type R = [string, string, number, number, string, number, number];
  const z = '0 | 0 | 0 | 0 | 0 | 0 | 0';
  const rows: R[] = [
    ['Pradhap M', 'Pradhap M', 5, 6, '0 | 0 | 0 | 6 | 0 | 0 | 0', 1.2, 0],
    ['Kumaresan', 'Kumaresan', 5, 4, '0 | 0 | 0 | 4 | 0 | 0 | 0', 0.8, 0],
    ['Hariharasudhan', 'Kumaresan', 5, 3, '0 | 0 | 0 | 3 | 0 | 0 | 0', 0.6, 0],
    ['Shabir Ahmed S', 'Pradhap M', 5, 3, '0 | 0 | 0 | 2 | 0 | 1 | 0', 0.6, 0],
    ['Muhammed Ramees J', 'Kumaresan', 5, 2, '0 | 0 | 1 | 1 | 0 | 0 | 0', 0.4, 0],
    ['Hariharen A', 'Hariharen A', 5, 1, '0 | 0 | 0 | 0 | 0 | 1 | 0', 0.2, 0],
    ['Nisha Banu', 'Direct Reporting', 5, 0, z, 0, 0],
    ['Jothi Malar S', 'Hariharen A', 5, 0, z, 0, 2],
    ['Ranjith', 'Pradhap M', 5, 0, z, 0, 0],
    ['Vishmitha V', 'Pradhap M', 5, 0, z, 0, 0],
  ];
  rows.forEach((r, i) => {
    const row = 4 + i;
    g.set(row, 0, r[0]); g.set(row, 1, r[1]); g.set(row, 2, r[2], { al: 'c' });
    g.set(row, 3, r[3], { al: 'c', bg: r[3] > 0 ? '#ffff00' : undefined });
    g.set(row, 4, r[4], { al: 'c' });
    g.set(row, 5, r[5].toFixed(1), { al: 'c', bg: heat2(r[5]) });
    g.set(row, 6, r[6], { al: 'c' });
  });
  const DK = '#0b3d4a';
  const tl: R[] = [
    ['', 'Kumaresan', 15, 9, '0 | 0 | 1 | 8 | 0 | 0 | 0', 0.6, 0],
    ['', 'Pradhap M', 20, 9, '0 | 0 | 0 | 8 | 0 | 1 | 0', 0.5, 0],
    ['', 'Hariharen A', 10, 1, '0 | 0 | 0 | 0 | 0 | 1 | 0', 0.1, 2],
    ['', 'Direct Reporting', 5, 0, z, 0, 0],
  ];
  g.set(14, 0, 'Bookings', { bg: '#00ffff', b: 1, al: 'c' }); g.merge(14, 0, 4, 1); g.fill(14, 0, 4, 1, { bg: '#00ffff' });
  tl.forEach((r, i) => {
    const row = 14 + i, st = { bg: DK, fg: WHITE, b: 1 as const };
    g.set(row, 1, r[1], st); g.set(row, 2, r[2], { ...st, al: 'c' }); g.set(row, 3, r[3], { ...st, al: 'c' }); g.set(row, 4, r[4], { ...st, al: 'c' });
    g.set(row, 5, r[5].toFixed(1), { al: 'c', b: 1, bg: heat2(r[5]) }); g.set(row, 6, r[6], { ...st, al: 'c' });
  });
  ['50', '19', '0 | 0 | 1 | 16 | 0 | 2 | 0', '3.8', '2'].forEach((v, i) => g.set(18, 2 + i, v, { bg: '#ff6d00', fg: WHITE, b: 1, al: 'c' }));
  return g.build(19, 7);
}

// ── 3. Today Demo ──────────────────────────────────────────────────────
function todayDemo(): SheetContent {
  const g = new G([150, 150, 220], 3);
  g.set(0, 0, 'Today', { bg: '#ffff00', b: 1, al: 'c' }); g.set(0, 1, '10/29/2026', { bg: '#ffff00', al: 'c' });
  ['BDA', 'TL', 'Student Name'].forEach((t, i) => g.set(2, i, t, { bg: '#fbbc04', b: 1, al: 'c' }));
  const rows: [string, string, string[]][] = [
    ['Nisha Banu', 'Direct Reporting', ['Nil']],
    ['Hariharen A', 'Hariharen A', ['Sibiraju', 'Aathmika']],
    ['Jothi Malar S', 'Hariharen A', ['Biju', 'Saravanakumar']],
    ['Hariharasudhan', 'Kumaresan', ['Sam', 'Dharsana V', 'Vinothini']],
    ['Kumaresan', 'Kumaresan', ['HARITHA', 'Sowbarni', 'Tamilarasi', 'SRI VARSHINI S', 'RAJAHARINI']],
    ['Muhammed Ramees J', 'Kumaresan', ['Sruthika', 'Raffik']],
    ['Pradhap M', 'Pradhap M', ['Vijaya Sri', 'Ezhumalai', 'Nithya Gomathi', 'Siva', 'Dharshini B', 'Kanish Kumar', 'Dhivya E', 'Sabari']],
    ['Ranjith', 'Pradhap M', ['Nil']],
    ['Shabir Ahmed S', 'Pradhap M', ['Kanishka', 'Prana']],
    ['Vishmitha V', 'Pradhap M', ['Nil']],
  ];
  rows.forEach((r, i) => {
    const row = 3 + i;
    g.set(row, 0, r[0]); g.set(row, 1, r[1]); g.set(row, 2, r[2].join('\n'), { al: 'c' });
    g.rowHeights[String(row)] = Math.max(22, r[2].length * 16 + 6);
  });
  return g.build(13, 3);
}

// ── 4. Booking Response ────────────────────────────────────────────────
function bookingResponse(): SheetContent {
  const g = new G([46, 130, 130, 140, 120, 80, 110, 80, 90, 80, 280, 80, 170, 220, 90, 60, 130, 70], 1);
  const H = '#4a86e8';
  ['S:No', 'Student Name', 'Timestamp', 'Advisor Name', 'TL Name', 'Selection', 'Client Mobile Number', 'Demo Type', 'Demo Date', 'Demo Slot', 'Comments', 'Source'].forEach((t, i) => g.set(0, i, t, { bg: H, fg: WHITE, b: 1, al: 'c' }));
  g.set(0, 12, 'Staus', { bg: '#c27ba0', fg: WHITE, b: 1, al: 'c' }); g.set(0, 13, 'Comments', { bg: '#c27ba0', fg: WHITE, b: 1, al: 'c' });
  g.set(0, 14, '', { bg: '#d9d9d9' }); g.set(0, 15, '', { bg: H }); g.set(0, 16, 'Demo', { bg: H, fg: WHITE, b: 1, al: 'c' }); g.set(0, 17, 'Month', { bg: H, fg: WHITE, b: 1, al: 'c' });
  // [name, timestamp, advisor, tl, mobile, type, demoDate, slot, comments, status, statusComment, day, demo]
  type R = [string, string, string, string, string, string, string, string, string, string, string, string, string];
  const rows: R[] = [
    ['Ajmal', '2/24/2026 11:52:25', 'Swathika K', 'Kumaresan', '8124725695', 'Offline', '2/25/2026', '11 - 12', 'BCA in 2023, worked as Developer, intere…', 'DNP', '', 'Wed', ''],
    ['Kavitha', '2/24/2026 12:03:41', 'Jothi Malar S', 'Hariharen A', '9944564043', 'Online', '2/25/2026', '4 - 5', 'BSC physics - 2011\nB-ED - 2012\nplanning in IT\nno Idea\nNon coding.', '', '', 'Tue', ''],
    ['Dinesh Kumar', '2/24/2026 12:14:19', 'Shabir Ahmed S', 'Pradhap M', '7904731091', 'Online', '2/25/2026', '1 - 2', '2025///m.com //exp no fresher// looking ba…', 'Conducted', '', 'Wed', 'Need to Followup'],
    ['Joseph', '2/24/2026 12:27:03', 'Jothi Malar S', 'Hariharen A', '8438780978', 'Online', '2/24/2026', '10 - 11', 'will attend the session by today', 'Conducted', 'Conducted he will visit on 28th directly', 'Tue', 'Interested'],
    ['Johnson', '2/24/2026 12:36:01', 'Ranjith', 'Pradhap M', '9488588659', 'Online', '2/25/2026', '5 - 6', 'Only for internship', 'Conducted', '', 'Wed', '50 - 50'],
    ['Nivetha', '2/24/2026 12:42:51', 'Hariharasudhan', 'Kumaresan', '6379563954', 'Online', '2/25/2026', '3 - 4', '2.5 YEARS OF EXP IN PROCESS EXEC…', 'DNP', '', 'Wed', ''],
    ['Sakthivel', '2/24/2026 12:53:35', 'Muhammed Ramees J', 'Hariharen A', '7539952488', 'Online', '2/25/2026', '10 - 11', 'Dont have any idea about IT / but he need…', 'Rescheduled & Form Filled', '', 'Wed', ''],
    ['Srimathi', '2/24/2026 12:56:12', 'Muhammed Ramees J', 'Hariharen A', '7539980374', 'Online', '2/25/2026', '11 - 12', 'looking for jobs in IT', 'Conducted', '', 'Wed', 'Not Interested'],
    ['Nandhini', '2/24/2026 13:31:33', 'Midhun K', 'Kumaresan', '9345968851', 'Online', '2/24/2026', '5 - 6', 'BCA - 2025\nNCR college\ninterested in web development and fullstac…\nhavent done any certifications or internsh…\nfrom dindugul\nwill attend by 5 o clock today', 'Conducted', '', 'Tue', 'Need to Followup'],
    ['Akash', '2/24/2026 13:41:56', 'Midhun K', 'Kumaresan', '9345342618', 'Offline', '2/25/2026', '5 - 6', 'Bsc IT - 2026,pioneer college,non coding …\nsaid he will come wednesday. need to …\n3. will come tomorrow after college by 5:3…', 'Conducted', '', 'Wed', 'Interested'],
    ['Alaghuhariharan M', '2/24/2026 14:54:43', 'Shabir Ahmed S', 'Pradhap M', '8072748110', 'Offline', '2/25/2026', '11 - 12', 'completed BSC -2025\nlooking for IT jobs and suggested for profil…', 'Rescheduled & Form Filled', '', 'Wed', ''],
    ['Abbas', '2/24/2026 14:59:17', 'Nishanthini S', 'Hariharen A', '7598310934', 'Offline', '2/25/2026', '9 - 10', 'bsc /2023/ worked in system admin role / r…', 'DNP', '7598310934', 'Wed', ''],
    ['Lakshmi', '2/24/2026 15:09:55', 'Ranjith', 'Pradhap M', '7010314011', 'Offline', '2/25/2026', '11 - 12', 'Interested', 'Rescheduled & Form Filled', '', 'Wed', ''],
    ['Vishwajith', '2/24/2026 15:17:08', 'Muhammed Ramees J', 'Hariharen A', '7548879516', 'Offline', '2/25/2026', '10 - 11', 'One year career gap / looking for jobs in IT', 'Conducted', '', 'Wed', 'Need to Followup'],
    ['Sri Durga Devi.K', '2/24/2026 15:23:19', 'Pradhap M', 'Pradhap M', '9342322260', 'Offline', '2/26/2026', '11 - 12', 'BSC CS - 2025\nSelvapuram\nWill Visit by Thursday - 11am\nInterested in Front End\n6 Month Intern Completed', 'DNP', '', 'Thu', ''],
    ['Gangadevi', '2/24/2026 15:50:13', 'Kumaresan', 'Kumaresan', '8072778297', 'Offline', '2/26/2026', '10 - 11', 'BCA - 2025 - KONGUNADU - EXP - INTE…\nFATHER : WORKING - DIRECT DEMO FI…', 'DNP', '', 'Thu', ''],
    ['Vishnu Vardhan', '2/24/2026 15:52:42', 'Midhun K', 'Kumaresan', '8248777809', 'Offline', '2/25/2026', '10 - 11', 'BCA - 2025.AR calling - 6 months exp,qui…\nfrom mettupalayam,will come tomorrow by…', 'DNP', '', 'Wed', ''],
    ['Thouflin shilfiya', '2/24/2026 15:56:27', 'Jothi Malar S', 'Hariharen A', '7871784549', 'Online', '2/25/2026', '12 - 1', 'bcom - 2024,Erode,no idea in IT,pitched fo…', 'DNP', '', 'Wed', ''],
    ['Rithish kumar', '2/24/2026 16:02:19', 'Jothi Malar S', 'Hariharen A', '8825525768', 'Online', '2/25/2026', '5 - 6', 'BE CS final year. interested in IT planning', 'DNP', '', 'Wed', ''],
    ['Raman', '2/24/2026 16:03:30', 'Midhun K', 'Kumaresan', '7094309735', 'Offline', '2/25/2026', '11 - 12', 'referral of akash\nBsc IT\npioneer college\nwill come tomorrow by 11', 'DNP', '', 'Wed', ''],
  ];
  const stColor: Record<string, string> = { DNP: '#ffff00', Conducted: '#6aa84f', 'Rescheduled & Form Filled': '#6d9eeb' };
  rows.forEach((r, i) => {
    const row = 1 + i;
    g.set(row, 0, i + 1, { al: 'c' }); g.set(row, 1, r[0]); g.set(row, 2, r[1], { al: 'c' }); g.set(row, 3, r[2]); g.set(row, 4, r[3]); g.set(row, 5, 'Booking', { al: 'c' });
    g.set(row, 6, r[4], { al: 'c' }); g.set(row, 7, r[5], { al: 'c' }); g.set(row, 8, r[6], { al: 'c' }); g.set(row, 9, r[7], { al: 'c' }); g.set(row, 10, r[8]);
    g.set(row, 12, r[9], { al: 'c', b: 1, bg: stColor[r[9]] }); g.set(row, 13, r[10]);
    g.set(row, 14, '2/24/2026', { al: 'c', bg: '#d9d9d9' }); g.set(row, 15, r[11], { al: 'c' }); g.set(row, 16, r[12], { al: 'c' }); g.set(row, 17, 'Feb', { al: 'c' });
    const lines = r[8].split('\n').length;
    if (lines > 1) g.rowHeights[String(row)] = lines * 16 + 6;
  });
  return g.build(21, 18);
}

// ── 5. Demo Response ───────────────────────────────────────────────────
function demoResponse(): SheetContent {
  const g = new G([46, 130, 130, 140, 120, 80, 110, 110, 330, 110, 100, 60, 110, 300], 1);
  const H = '#ffc000';
  ['S:No', 'Name', 'Timestamp', 'Advisor', 'TL', 'Selection', 'Phone Number', 'Demo Status', 'Comments', 'Source', 'Demo Done Date', 'Coco'].forEach((t, i) => g.set(0, i, t, { bg: H, b: 1, al: 'c' }));
  g.set(0, 12, 'Demo Status', { bg: '#ff6d00', fg: WHITE, b: 1, al: 'c' }); g.set(0, 13, 'Comments', { bg: '#ff6d00', fg: WHITE, b: 1, al: 'c' });
  // [name, ts, advisor, tl, phone, demoStatus, comments, source, date, finalStatus, finalComment]
  type R = [string, string, string, string, string, string, string, string, string, string, string];
  const F = 'Need  to Followup';
  const rows: R[] = [
    ['Joseph', '2/24/2026 12:29:13', 'Jothi Malar S', 'Hariharen A', '8438780978', 'Interested', 'will confirm within 2 days', '', '2/24/2026', 'Sale', ''],
    ['Monisha', '2/24/2026 13:46:07', 'Hariharasudhan', 'Kumaresan', '8807345868', 'Interested', 'Have to discuss with parent and will update by evening', '', '2/24/2026', 'Follow Up', 'After college - follow up'],
    ['NA', '2/24/2026 17:59:10', 'Ranjith', 'Pradhap M', '6380379836', '50 - 50', 'Follow up', '', '2/24/2026', '', ''],
    ['NA', '2/24/2026 18:04:03', 'Nishanthini S', 'Hariharen A', '7092428537', F, 'he will update after discussing with family', '', '2/24/2026', '', ''],
    ['NA', '2/24/2026 18:22:06', 'Jothi Malar S', 'Hariharen A', '9363920452', F, 'Planning After Semester\n3rd year starting.', '', '2/24/2026', 'Follow Up', ''],
    ['Nandhini', '2/24/2026 18:42:29', 'Midhun K', 'Kumaresan', '9345968851', F, 'she is preparing for banking exams with family guidance but she is intereste…', '', '2/24/2026', 'Positive', ''],
    ['NA', '2/24/2026 19:06:16', 'Pradhap M', 'Pradhap M', '7904288674', 'Interested', 'Interested in FullStack', '', '2/24/2026', '', ''],
    ['sridhar', '2/25/2026 11:15:41', 'Nishanthini S', 'Hariharen A', '7010116148', F, 'he will update after discussing with parents', 'B2B', '2/25/2026', 'Negative', 'already he learning by himself so he said not interested for paid co…'],
    ['Vishwajith', '2/25/2026 12:00:06', 'Muhammed Ramees J', 'Hariharen A', '7548879516', F, 'need to follow up and close for next month', '', '2/25/2026', 'May Be Later', ''],
    ['Srimathi', '2/25/2026 12:02:02', 'Muhammed Ramees J', 'Hariharen A', '7539980374', 'Not Interested', 'she is looking for HR jobs alone', '', '2/25/2026', 'Negative', ''],
    ['Akash', '2/25/2026 12:41:07', 'Midhun K', 'Kumaresan', '9345342618', 'Interested', 'pitched about Ui/UX. will pay initial registration of 1k in two days. need to tak…', '', '2/25/2026', 'Positive', 'pitched about Ui/UX. will pay initial registration of 1k in two days. ne…\nfeedback call tomorrow. will speak with his friend too and will confir…\n// will come with raman by monday // 28-2 11am DNP'],
    ['Vishnu Priya R', '2/25/2026 12:43:20', 'Swathika K', 'Kumaresan', '8220730198', 'Interested', 'offline demo completed, interested in DM, will update by Tomorrow', 'Outbound Fresh', '2/25/2026', 'Negative', ''],
    ['Rajeev', '2/25/2026 12:44:23', 'Midhun K', 'Kumaresan', '9042963393', 'Not Interested', 'said he cant spend for courses now. just came along with jemima to see if h…', 'Referral', '2/25/2026', 'Negative', ''],
    ['Priyanka S', '2/25/2026 12:48:48', 'Swathika K', 'Kumaresan', '9025677304', F, 'offline demo completed, interested in DA, will update by Tomorrow', 'Outbound Fresh', '2/25/2026', 'Follow Up', 'DNP'],
    ['SUGANTHI M', '2/25/2026 12:50:59', 'Jothi Malar S', 'Hariharen A', '7868043883', '50 - 50', 'BSC/MSC - Chemistry\npitched For DM\nShe will discuss and update.', 'Outbound Fresh', '2/25/2026', 'Negative', ''],
    ['Jemima Elizabeth', '2/25/2026 12:52:47', 'Midhun K', 'Kumaresan', '6381813427', 'Not Interested', 'said she cant join in the upcoming batch. gonna try for jobs for few months a…', 'B2B', '2/25/2026', 'Negative', 'DNP'],
    ['arun kumar', '2/25/2026 13:19:41', 'Nishanthini S', 'Hariharen A', '9080168486', '50 - 50', 'demo conducted he will update after discussing with parents / march batch p…', 'B2B', '2/25/2026', 'DNP', 'dnp'],
    ['Ganjendran T', '2/25/2026 15:09:44', 'Hariharen A', 'Hariharen A', '9751198912', 'Interested', 'will join directly tomorrow', 'IB walkin', '2/25/2026', 'Sale', ''],
    ['Baradharaj', '2/25/2026 17:24:45', 'Muhammed Ramees J', 'Hariharen A', '9894072845', F, 'Already completed MERN stack / pitched for Data verse', 'B2B', '2/25/2026', 'Negative', ''],
    ['dhivya', '2/25/2026 17:39:11', 'Nishanthini S', 'Hariharen A', '8667729594', '50 - 50', 'demo conducted pitched for data analyst and data verse pro / interested but …', 'Outbound DB', '2/25/2026', 'DNP', 'dnp'],
    ['Dinesh Kumar', '2/25/2026 17:47:35', 'Shabir Ahmed S', 'Pradhap M', '7904731091', F, 'Attend the demo since the candiate is low potential will join later for the cour…', '', '2/25/2026', 'DNP', 'Long DNP'],
    ['Johnson', '2/25/2026 18:00:29', 'Ranjith', 'Pradhap M', '9488588659', '50 - 50', 'May be', '', '2/25/2026', 'May Be Later', '2 Months after'],
    ['Aswath L', '2/25/2026 18:42:38', 'Jothi Malar S', 'Hariharen A', '7402121525', 'Interested', 'Planning in DA. He will update Tomorrow', 'Outbound Fresh', '2/25/2026', 'DNP', 'dnp'],
    ['Kaviyanjali', '2/26/2026 10:41:33', 'Ranjith', 'Pradhap M', '6383661169', F, 'Follow up', 'Outbound Fresh', '2/26/2026', 'Negative', ''],
    ['Assumtha Sheebha SH', '2/26/2026 11:24:07', 'Kumaresan', 'Kumaresan', '9578659932', '50 - 50', 'DA and DM Pitched - asking wfh jobs - call back saturday', 'Referral', '2/26/2026', 'Positive', 'will update by Tomorrow'],
    ['Sakthivel', '2/26/2026 11:24:39', 'Muhammed Ramees J', 'Hariharen A', '7539952488', 'Interested', 'Interested in doing DM / but his parents are daily wage workers', '', '2/26/2026', 'May Be Later', ''],
    ['Deepak', '2/26/2026 12:05:04', 'Ranjith', 'Pradhap M', '6384565575', 'Interested', 'Interested', 'Outbound Fresh', '2/26/2026', 'Negative', 'Financial Issue'],
    ['Amala Y', '2/26/2026 12:40:32', 'Shabir Ahmed S', 'Pradhap M', '9080762014', 'Interested', 'suggested data Analytics / pitched 25,000/- //and will update by tomorrow e…', 'B2B', '2/26/2026', 'Sale', ''],
    ['Simhika R M', '2/26/2026 13:22:04', 'Swathika K', 'Kumaresan', '9360073488', 'Interested', 'online demo completed, interested in DA, will update by Tomorrow', 'B2B', '2/26/2026', 'Follow Up', 'DNP'],
    ['Sindhu Sree S', '2/26/2026 13:27:34', 'Swathika K', 'Kumaresan', '6383069787', F, 'online demo completed, interested in UI\\UX, will update by Saturday', 'Outbound Fresh', '2/26/2026', 'Follow Up', 'DNP'],
    ['Pharameswari', '2/26/2026 15:02:07', 'Pradhap M', 'Pradhap M', '8098642385', '50 - 50', 'Already Course Pursuing Self learn, Need to Discuss with family for paid cou…', 'B2B', '2/26/2026', 'Negative', 'Asking Free Course'],
    ['Supraja', '2/26/2026 15:23:42', 'Hariharen A', 'Hariharen A', '9994225095', 'Interested', 'interested', 'Referral', '2/26/2026', 'Positive', 'will confirm within few days'],
    ['Tharrun', '2/26/2026 15:30:53', 'Hariharen A', 'Hariharen A', '9894356006', 'Interested', 'cx will confirm within today or tomorrow', 'IB Whatsapp', '2/26/2026', 'Positive', 'will confirm within few days'],
    ['Akash', '2/26/2026 16:01:21', 'Shabir Ahmed S', 'Pradhap M', '9384979878', F, 'The candidate has an indent to move to upskilling in DA domain will join by …', 'General', '2/26/2026', 'May Be Later', ''],
  ];
  rows.forEach((r, i) => {
    const row = 1 + i;
    g.set(row, 0, i + 1, { al: 'c' }); g.set(row, 1, r[0], { al: 'c' }); g.set(row, 2, r[1], { al: 'c' }); g.set(row, 3, r[2], { al: 'c' }); g.set(row, 4, r[3], { al: 'c' });
    g.set(row, 5, 'Demo Over', { al: 'c' }); g.set(row, 6, r[4], { al: 'c' }); g.set(row, 7, r[5], { al: 'c' }); g.set(row, 8, r[6]); g.set(row, 9, r[7], { al: 'c' }); g.set(row, 10, r[8], { al: 'c' });
    g.set(row, 12, r[9], { al: 'c' }); g.set(row, 13, r[10]);
    const lines = Math.max(r[6].split('\n').length, r[10].split('\n').length);
    if (lines > 1) g.rowHeights[String(row)] = lines * 16 + 6;
  });
  return g.build(35, 14);
}

export const BRD_TRACKER_SHEETS: { name: string; content: SheetContent }[] = [
  { name: 'Booking', content: booking() },
  { name: 'Booked VS Conducted', content: bookedVsConducted() },
  { name: 'Today Demo', content: todayDemo() },
  { name: 'Booking Response', content: bookingResponse() },
  { name: 'Demo Response', content: demoResponse() },
];
