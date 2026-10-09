import prisma from '../config/database';
import { emailService } from './email.service';

/**
 * Emails to each student's mapped Sales advisor (Student.skillAdvisorId):
 *  1. a daily CUMULATIVE attendance matrix for every running sub-batch — from
 *     the first marked class day up to today (5–9 Oct today, 5–10 Oct
 *     tomorrow ...) — until the trainer marks the classes completed;
 *  2. a one-off "classes completed — project presentation on <date>" notice.
 */

const IST = 'Asia/Kolkata';
const ymd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: IST }); // yyyy-mm-dd
const pretty = (d: Date) => d.toLocaleDateString('en-IN', { timeZone: IST, day: '2-digit', month: 'short', year: 'numeric' });
const shortDay = (d: Date) => d.toLocaleDateString('en-IN', { timeZone: IST, day: '2-digit', month: 'short' });

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TH = 'style="border:1px solid #d0d7de;padding:4px 6px;background:#f1f5f9;font-size:11px;white-space:nowrap"';
const TD = 'style="border:1px solid #d0d7de;padding:4px 6px;font-size:12px;text-align:center"';
// P-ON = present online, P-OFF = present offline, A = absent.
function cellFor(status?: string, mode?: string | null): { t: string; bg: string } {
  if (!status) return { t: '–', bg: '#ffffff' };
  if (status === 'ABSENT') return { t: 'A', bg: '#fecaca' };
  if (mode === 'ONLINE') return { t: 'P-ON', bg: '#bfdbfe' };
  if (mode === 'OFFLINE') return { t: 'P-OFF', bg: '#d1fae5' };
  return { t: 'P', bg: '#e5e7eb' }; // marked present before online/offline was recorded
}

interface Advisor { id: string; name: string; email: string }
type SchedLite = { id: string; code: string | null; batch: { code: string }; course: { name: string } };

type Student = { id: string; name: string; code: string; advisor: string };

async function advisorGroups(scheduleId: string) {
  const enrollments = await prisma.studentBatchEnrollment.findMany({
    where: { scheduleId, status: 'ACTIVE' },
    include: {
      student: {
        select: {
          id: true, firstName: true, lastName: true, studentCode: true,
          skillAdvisor: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      },
    },
  });
  const groups = new Map<string, { advisor: Advisor; students: Student[] }>();
  const all: Student[] = [];
  for (const e of enrollments) {
    const a = e.student.skillAdvisor;
    const st: Student = { id: e.student.id, name: `${e.student.firstName} ${e.student.lastName}`, code: e.student.studentCode, advisor: a ? `${a.firstName} ${a.lastName}` : '— not mapped —' };
    all.push(st);
    if (!a?.email) continue;
    if (!groups.has(a.id)) groups.set(a.id, { advisor: { id: a.id, name: `${a.firstName} ${a.lastName}`, email: a.email }, students: [] });
    groups.get(a.id)!.students.push(st);
  }
  return { groups, all };
}

/** Same recipients the escalation emails use: everyone with EDIT+ on the Production module. */
async function productionManagers(): Promise<Advisor[]> {
  const grants = await prisma.userModuleAccess.findMany({
    where: { module: 'PRODUCTION_TRAINING', accessLevel: { in: ['EDIT', 'ADMIN'] } },
    include: { user: { include: { employee: true } } },
  });
  const m = new Map<string, Advisor>();
  for (const g of grants) {
    const email = g.user.employee?.email || g.user.email;
    if (email) m.set(email, { id: g.userId, email, name: g.user.employee ? `${g.user.employee.firstName} ${g.user.employee.lastName}` : g.user.email });
  }
  return Array.from(m.values());
}

export const salesAdvisorReportService = {
  /** Daily 8:30 PM job. Skips a sub-batch on days nobody's attendance was marked (no class today → nothing new to say). Goes to each student's Sales advisor (their own students) and to the Production Manager(s) (every student, with the advisor's name). */
  async sendCumulativeAttendance(): Promise<{ emails: number; schedules: number }> {
    const todayKey = ymd(new Date());
    const schedules = await prisma.batchCourseSchedule.findMany({
      where: { classesCompletedAt: null, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      select: { id: true, code: true, batch: { select: { code: true } }, course: { select: { name: true } } },
    });

    const perAdvisor = new Map<string, { advisor: Advisor; sections: string[] }>();
    const pmSections: string[] = [];
    let used = 0;

    for (const sch of schedules as SchedLite[]) {
      const records = await prisma.studentAttendance.findMany({
        where: { scheduleId: sch.id }, select: { studentId: true, date: true, status: true, mode: true }, orderBy: { date: 'asc' },
      });
      if (!records.length) continue;
      if (!records.some((r) => ymd(r.date) === todayKey)) continue; // no class marked today

      const dayKeys = Array.from(new Set(records.map((r) => ymd(r.date)))).sort();
      const dayDates = dayKeys.map((k) => records.find((r) => ymd(r.date) === k)!.date);
      const byStudent = new Map<string, Map<string, { status: string; mode: string | null }>>();
      for (const r of records) {
        if (!byStudent.has(r.studentId)) byStudent.set(r.studentId, new Map());
        byStudent.get(r.studentId)!.set(ymd(r.date), { status: r.status, mode: r.mode });
      }

      const { groups, all } = await advisorGroups(sch.id);
      if (!all.length) continue;
      used++;
      const label = `${sch.batch.code}${sch.code ? ` / ${sch.code}` : ''} — ${sch.course.name}`;
      const head = dayDates.map((d) => `<th ${TH}>${shortDay(d)}</th>`).join('');

      const table = (students: Student[], withAdvisor: boolean) => {
        const body = students.map((s) => {
          const m = byStudent.get(s.id) || new Map<string, { status: string; mode: string | null }>();
          let present = 0, marked = 0;
          const cells = dayKeys.map((k) => {
            const v = m.get(k);
            if (v) { marked++; if (v.status !== 'ABSENT') present++; }
            const c = cellFor(v?.status, v?.mode);
            return `<td style="border:1px solid #d0d7de;padding:4px 6px;font-size:12px;text-align:center;white-space:nowrap;background:${c.bg}">${c.t}</td>`;
          }).join('');
          const pct = marked ? Math.round((present / marked) * 100) : 0;
          const adv = withAdvisor ? `<td style="border:1px solid #d0d7de;padding:4px 6px;font-size:12px;white-space:nowrap">${esc(s.advisor)}</td>` : '';
          return `<tr><td style="border:1px solid #d0d7de;padding:4px 6px;font-size:12px;white-space:nowrap">${esc(s.code)}</td><td style="border:1px solid #d0d7de;padding:4px 6px;font-size:12px;white-space:nowrap">${esc(s.name)}</td>${adv}${cells}<td ${TD}><b>${present}/${marked}</b> (${pct}%)</td></tr>`;
        }).join('');
        return `<table style="border-collapse:collapse"><tr><th ${TH}>ID</th><th ${TH}>Student</th>${withAdvisor ? `<th ${TH}>Sales advisor</th>` : ''}${head}<th ${TH}>Attended</th></tr>${body}</table>`;
      };
      const intro = `<h3 style="margin:18px 0 4px;font-size:14px">${esc(label)}</h3>
<p style="margin:0 0 6px;font-size:12px;color:#555">Classes from <b>${pretty(dayDates[0])}</b> to <b>${pretty(dayDates[dayDates.length - 1])}</b> (${dayKeys.length} class days)</p>`;

      pmSections.push(intro + table(all, true));
      for (const g of groups.values()) {
        const section = intro + table(g.students, false);
        const cur = perAdvisor.get(g.advisor.id);
        if (cur) cur.sections.push(section); else perAdvisor.set(g.advisor.id, { advisor: g.advisor, sections: [section] });
      }
    }

    const legend = `<b>P-ON</b> = present online, <b>P-OFF</b> = present offline, <b>A</b> = absent, <b>P</b> = present (mode not recorded), – = not marked.`;
    const footer = `<p style="font-size:12px;color:#777;margin-top:18px">Sent each class day until the trainer marks the classes completed.</p>`;
    let emails = 0;
    for (const { advisor, sections } of perAdvisor.values()) {
      await emailService.send({
        to: advisor.email,
        subject: `Student attendance update — ${pretty(new Date())}`,
        template: 'advisor-attendance',
        html: `<p>Hi ${esc(advisor.name)},</p><p>Cumulative attendance of <b>your students</b> up to today. ${legend}</p>${sections.join('')}${footer}`,
      }).then(() => { emails++; }).catch(() => {});
    }
    if (pmSections.length) {
      for (const pm of await productionManagers()) {
        await emailService.send({
          to: pm.email,
          subject: `Attendance — all running batches — ${pretty(new Date())}`,
          template: 'pm-attendance',
          html: `<p>Hi ${esc(pm.name)},</p><p>Cumulative attendance of all running sub-batches up to today. ${legend}</p>${pmSections.join('')}${footer}`,
        }).then(() => { emails++; }).catch(() => {});
      }
    }
    return { emails, schedules: used };
  },

  /** Immediately when a trainer completes the classes: tell each advisor which of their students finished and the presentation date. */
  async sendCompletionNotice(scheduleId: string, presentationDate: Date): Promise<number> {
    const sch = await prisma.batchCourseSchedule.findUnique({
      where: { id: scheduleId },
      select: { id: true, code: true, batch: { select: { code: true } }, course: { select: { name: true } } },
    });
    if (!sch) return 0;
    const { groups, all } = await advisorGroups(scheduleId);
    const label = `${sch.batch.code}${sch.code ? ` / ${sch.code}` : ''} — ${sch.course.name}`;
    let sent = 0;
    for (const g of groups.values()) {
      const rows = g.students.map((s) => `<li>${esc(s.name)} (${esc(s.code)})</li>`).join('');
      await emailService.send({
        to: g.advisor.email,
        subject: `Classes completed — ${label} · Project presentation ${pretty(presentationDate)}`,
        template: 'advisor-classes-completed',
        html: `<p>Hi ${esc(g.advisor.name)},</p>
<p>The classes for <b>${esc(label)}</b> are now <b>completed</b> and the batch has moved to its <b>project phase</b>.</p>
<p><b>Project presentation date: ${pretty(presentationDate)}</b></p>
<p>Your students in this batch:</p><ul>${rows}</ul>
<p>Daily attendance emails for this batch will stop from now.</p>`,
      }).then(() => { sent++; }).catch(() => {});
    }
    // Production Manager(s) get the same notice with the full student list.
    const pmRows = all.map((s) => `<li>${esc(s.name)} (${esc(s.code)}) — advisor: ${esc(s.advisor)}</li>`).join('');
    for (const pm of await productionManagers()) {
      await emailService.send({
        to: pm.email,
        subject: `Classes completed — ${label} · Project presentation ${pretty(presentationDate)}`,
        template: 'pm-classes-completed',
        html: `<p>Hi ${esc(pm.name)},</p><p>The trainer has marked the classes for <b>${esc(label)}</b> as <b>completed</b>. The batch is now in its <b>project phase</b>.</p><p><b>Project presentation date: ${pretty(presentationDate)}</b></p><ul>${pmRows}</ul>`,
      }).then(() => { sent++; }).catch(() => {});
    }
    return sent;
  },
};
