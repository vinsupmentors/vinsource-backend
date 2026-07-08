import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { paginate, formatPagination } from '../utils/helpers';
import { getEffectiveAccess } from '../utils/moduleAccess';

const employeeSelect = { id: true, firstName: true, lastName: true, employeeCode: true };
const vendorSelect = { id: true, name: true, category: true, status: true };

/**
 * This entity is run out of a separate Head Office (HO) which funds it
 * monthly. Regular employees ("spenders") should only ever see the expenses
 * they personally filed — never the company-wide HO funding/balance picture.
 * Only someone with ADMIN-level FINANCE_ADMIN access (or SUPER_ADMIN) sees
 * everyone's spending and the opening/closing balance reconciliation.
 */
async function canSeeAll(req: AuthRequest): Promise<boolean> {
  if (req.user?.role === 'SUPER_ADMIN') return true;
  if (!req.user) return false;
  const access = await getEffectiveAccess(req.user.userId);
  return access.FINANCE_ADMIN === 'ADMIN';
}

function monthRange(month?: string | number, year?: string | number) {
  const now = new Date();
  const y = year ? Number(year) : now.getFullYear();
  const m = month ? Number(month) - 1 : now.getMonth();
  const start = new Date(y, m, 1, 0, 0, 0, 0);
  const end = new Date(y, m + 1, 1, 0, 0, 0, 0);
  return { start, end };
}

export const financeAdminController = {
  async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 20, status, category, search, month, year } = req.query;
      const p = Number(page), l = Number(limit);

      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (category) where.category = category;
      if (search) where.title = { contains: String(search) };
      if (month || year) {
        const { start, end } = monthRange(month as string, year as string);
        where.expenseDate = { gte: start, lt: end };
      }

      const seeAll = await canSeeAll(req);
      if (!seeAll) {
        if (!req.user?.employeeId) {
          res.json({ success: true, data: [], meta: { ...formatPagination(0, p, l), totalAmount: 0 } });
          return;
        }
        where.requestedById = req.user.employeeId;
      }

      const [expenses, total, sumResult] = await Promise.all([
        prisma.adminExpense.findMany({
          where,
          include: {
            requestedBy: { select: employeeSelect },
            approvedBy: { select: employeeSelect },
            vendor: { select: vendorSelect },
          },
          orderBy: { expenseDate: 'desc' },
          ...paginate(p, l),
        }),
        prisma.adminExpense.count({ where }),
        prisma.adminExpense.aggregate({ where, _sum: { amount: true } }),
      ]);

      res.json({
        success: true,
        data: expenses,
        meta: { ...formatPagination(total, p, l), totalAmount: sumResult._sum.amount || 0 },
      });
    } catch (err) { next(err); }
  },

  async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { title, category, miscDescription, amount, notes, voucherNo, billNo, paymentMode, expenseDate, vendorId } = req.body;
      if (!title || !amount) throw new AppError('Title and amount are required', 400);

      // The expense is always attributed to whoever is actually logged in and
      // filing it — never to an arbitrary employee picked from a dropdown.
      // This is intentional: letting one person attribute spending to someone
      // else would let them frame a colleague, so `requestedById` from the
      // request body is ignored entirely.
      const spenderId = req.user?.employeeId;

      const files = req.files as { [field: string]: Express.Multer.File[] } | undefined;
      const billCopyUrl = files?.billCopy?.[0] ? `/uploads/expenses/${files.billCopy[0].filename}` : undefined;
      const paymentProofUrl = files?.paymentProof?.[0] ? `/uploads/expenses/${files.paymentProof[0].filename}` : undefined;

      const expense = await prisma.adminExpense.create({
        data: {
          title,
          category,
          miscDescription: category === 'Miscellaneous' ? miscDescription : undefined,
          amount: Number(amount),
          requestedById: spenderId,
          notes,
          voucherNo,
          billNo,
          paymentMode,
          billCopyUrl,
          paymentProofUrl,
          expenseDate: expenseDate ? new Date(expenseDate) : undefined,
          vendorId: vendorId || undefined,
        },
        include: { requestedBy: { select: employeeSelect }, vendor: { select: vendorSelect } },
      });
      res.status(201).json({ success: true, data: expense });
    } catch (err) { next(err); }
  },

  async updateStatus(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { status, approvedById } = req.body;
      if (!status) throw new AppError('Status is required', 400);

      const expense = await prisma.adminExpense.update({
        where: { id: req.params.id },
        data: {
          status,
          approvedById: ['APPROVED', 'REJECTED', 'PAID'].includes(status) ? approvedById : undefined,
          paidAt: status === 'PAID' ? new Date() : undefined,
        },
        include: { requestedBy: { select: employeeSelect }, approvedBy: { select: employeeSelect } },
      });
      res.json({ success: true, data: expense });
    } catch (err) { next(err); }
  },

  async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { title, category, miscDescription, amount, notes, voucherNo, billNo, paymentMode, expenseDate, vendorId } = req.body;

      const files = req.files as { [field: string]: Express.Multer.File[] } | undefined;
      const billCopyUrl = files?.billCopy?.[0] ? `/uploads/expenses/${files.billCopy[0].filename}` : undefined;
      const paymentProofUrl = files?.paymentProof?.[0] ? `/uploads/expenses/${files.paymentProof[0].filename}` : undefined;

      const expense = await prisma.adminExpense.update({
        where: { id: req.params.id },
        data: {
          title,
          category,
          miscDescription: category === 'Miscellaneous' ? miscDescription : (category !== undefined ? null : undefined),
          amount: amount !== undefined ? Number(amount) : undefined,
          notes,
          voucherNo,
          billNo,
          paymentMode,
          billCopyUrl,
          paymentProofUrl,
          expenseDate: expenseDate ? new Date(expenseDate) : undefined,
          vendorId: vendorId !== undefined ? (vendorId || null) : undefined,
        },
        include: { requestedBy: { select: employeeSelect }, vendor: { select: vendorSelect } },
      });
      res.json({ success: true, data: expense });
    } catch (err) { next(err); }
  },

  async remove(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await prisma.adminExpense.delete({ where: { id: req.params.id } });
      res.json({ success: true, message: 'Expense deleted' });
    } catch (err) { next(err); }
  },

  async stats(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const seeAll = await canSeeAll(req);
      const where: Record<string, unknown> = {};
      if (!seeAll) {
        if (!req.user?.employeeId) {
          res.json({ success: true, data: { statusTotals: {}, spentThisMonth: 0 } });
          return;
        }
        where.requestedById = req.user.employeeId;
      }

      const [byStatus, totalThisMonth] = await Promise.all([
        prisma.adminExpense.groupBy({ by: ['status'], where, _sum: { amount: true }, _count: { _all: true } }),
        prisma.adminExpense.aggregate({
          _sum: { amount: true },
          where: { ...where, expenseDate: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } },
        }),
      ]);

      const statusTotals: Record<string, { amount: number; count: number }> = {};
      for (const row of byStatus) {
        statusTotals[row.status] = { amount: row._sum.amount || 0, count: row._count._all };
      }

      res.json({
        success: true,
        data: { statusTotals, spentThisMonth: totalThisMonth._sum.amount || 0 },
      });
    } catch (err) { next(err); }
  },

  /**
   * Flexible, filterable expense report. Supports an arbitrary date range
   * (from/to, overriding the month/year quick-pick used elsewhere), plus
   * payment mode, category, vendor, status, spender (user), and free-text
   * search — any combination. Non-admin spenders are still scoped to their
   * own expenses (the `requestedById` filter is ignored for them, same as
   * `list`); admins can filter/report on anyone.
   * Returns the matching entries plus category/payment-mode/user/vendor
   * breakdowns for whatever the current filter set resolves to.
   */
  async report(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { from, to, category, paymentMode, status, vendorId, requestedById, search } = req.query;

      const where: Record<string, unknown> = {};
      if (category) where.category = category;
      if (paymentMode) where.paymentMode = paymentMode;
      if (status) where.status = status;
      if (vendorId) where.vendorId = vendorId;
      if (search) where.title = { contains: String(search) };
      if (from || to) {
        const dateFilter: Record<string, Date> = {};
        if (from) dateFilter.gte = new Date(`${from}T00:00:00`);
        if (to) dateFilter.lte = new Date(`${to}T23:59:59.999`);
        where.expenseDate = dateFilter;
      }

      const seeAll = await canSeeAll(req);
      if (!seeAll) {
        if (!req.user?.employeeId) {
          res.json({ success: true, data: { entries: [], totalAmount: 0, count: 0, byCategory: [], byPaymentMode: [], byUser: [], byVendor: [] } });
          return;
        }
        where.requestedById = req.user.employeeId;
      } else if (requestedById) {
        where.requestedById = requestedById;
      }

      const entries = await prisma.adminExpense.findMany({
        where,
        include: {
          requestedBy: { select: employeeSelect },
          approvedBy: { select: employeeSelect },
          vendor: { select: vendorSelect },
        },
        orderBy: { expenseDate: 'desc' },
      });

      const totalAmount = entries.reduce((s, e) => s + e.amount, 0);

      const sumBy = (keyFn: (e: typeof entries[number]) => string) => {
        const map = new Map<string, { amount: number; count: number }>();
        for (const e of entries) {
          const key = keyFn(e);
          const row = map.get(key) || { amount: 0, count: 0 };
          row.amount += e.amount;
          row.count += 1;
          map.set(key, row);
        }
        return [...map.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.amount - a.amount);
      };

      const byCategory = sumBy((e) => e.category || 'Uncategorized');
      const byPaymentMode = sumBy((e) => e.paymentMode || 'Unspecified');
      const byVendor = sumBy((e) => e.vendor?.name || 'No vendor');
      const byUser = seeAll ? sumBy((e) => e.requestedBy ? `${e.requestedBy.firstName} ${e.requestedBy.lastName}` : 'Unassigned') : [];

      res.json({
        success: true,
        data: { entries, totalAmount, count: entries.length, byCategory, byPaymentMode, byVendor, byUser },
      });
    } catch (err) { next(err); }
  },

  /** Category breakdown for a given month — company-wide, ADMIN-only (route-gated). */
  async categorySummary(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { month, year } = req.query;
      const { start, end } = monthRange(month as string, year as string);
      const rows = await prisma.adminExpense.groupBy({
        by: ['category'],
        where: { expenseDate: { gte: start, lt: end } },
        _sum: { amount: true },
      });
      const data = rows
        .map((r) => ({ category: r.category || 'Uncategorized', amount: r._sum.amount || 0 }))
        .sort((a, b) => b.amount - a.amount);
      const total = data.reduce((sum, r) => sum + r.amount, 0);
      res.json({ success: true, data: { categories: data, total } });
    } catch (err) { next(err); }
  },

  /**
   * Monthly HO ledger: Opening Balance (all HO credits minus all expenses
   * before the month) -> Credits (HO funds received this month) -> Debits
   * (expenses this month) -> Closing Balance. Company-wide, ADMIN-only.
   */
  async ledger(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { month, year } = req.query;
      const { start, end } = monthRange(month as string, year as string);

      const [priorCredits, priorDebits, monthCredits, monthDebits] = await Promise.all([
        prisma.hOFundReceipt.aggregate({ _sum: { amount: true }, where: { receivedDate: { lt: start } } }),
        prisma.adminExpense.aggregate({ _sum: { amount: true }, where: { expenseDate: { lt: start } } }),
        prisma.hOFundReceipt.findMany({
          where: { receivedDate: { gte: start, lt: end } },
          include: { recordedBy: { select: employeeSelect } },
          orderBy: { receivedDate: 'asc' },
        }),
        prisma.adminExpense.findMany({
          where: { expenseDate: { gte: start, lt: end } },
          include: { requestedBy: { select: employeeSelect }, vendor: { select: vendorSelect } },
          orderBy: { expenseDate: 'asc' },
        }),
      ]);

      const openingBalance = (priorCredits._sum.amount || 0) - (priorDebits._sum.amount || 0);

      type LedgerRow = {
        date: string; type: 'CREDIT' | 'DEBIT'; particulars: string; voucherNo?: string | null;
        billNo?: string | null; paymentMode?: string | null; party?: string | null;
        debit: number; credit: number; balance: number; notes?: string | null;
      };
      const rows: LedgerRow[] = [
        ...monthCredits.map((c) => ({
          date: c.receivedDate.toISOString(), type: 'CREDIT' as const, particulars: 'Funds Received from HO',
          party: c.recordedBy ? `${c.recordedBy.firstName} ${c.recordedBy.lastName}` : null,
          debit: 0, credit: c.amount, balance: 0, notes: c.notes,
        })),
        ...monthDebits.map((d) => ({
          date: d.expenseDate.toISOString(), type: 'DEBIT' as const,
          particulars: d.vendor ? `${d.title} (${d.vendor.name})` : d.title,
          voucherNo: d.voucherNo, billNo: d.billNo, paymentMode: d.paymentMode,
          party: d.requestedBy ? `${d.requestedBy.firstName} ${d.requestedBy.lastName}` : null,
          debit: d.amount, credit: 0, balance: 0, notes: d.notes,
        })),
      ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      let running = openingBalance;
      for (const row of rows) {
        running += row.credit - row.debit;
        row.balance = running;
      }

      const totalCredits = monthCredits.reduce((s, c) => s + c.amount, 0);
      const totalDebits = monthDebits.reduce((s, d) => s + d.amount, 0);
      const closingBalance = openingBalance + totalCredits - totalDebits;

      res.json({
        success: true,
        data: { openingBalance, totalCredits, totalDebits, closingBalance, entries: rows },
      });
    } catch (err) { next(err); }
  },

  // ── HO Fund Receipts (credits) ──────────────────────────────────────────
  async listFunds(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { month, year } = req.query;
      const where: Record<string, unknown> = {};
      if (month || year) {
        const { start, end } = monthRange(month as string, year as string);
        where.receivedDate = { gte: start, lt: end };
      }
      const funds = await prisma.hOFundReceipt.findMany({
        where,
        include: { recordedBy: { select: employeeSelect } },
        orderBy: { receivedDate: 'desc' },
      });
      res.json({ success: true, data: funds });
    } catch (err) { next(err); }
  },

  async createFund(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { amount, receivedDate, notes } = req.body;
      if (!amount) throw new AppError('Amount is required', 400);
      const fund = await prisma.hOFundReceipt.create({
        data: {
          amount: Number(amount),
          receivedDate: receivedDate ? new Date(receivedDate) : undefined,
          notes,
          recordedById: req.user?.employeeId,
        },
        include: { recordedBy: { select: employeeSelect } },
      });
      res.status(201).json({ success: true, data: fund });
    } catch (err) { next(err); }
  },

  async updateFund(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { amount, receivedDate, notes } = req.body;
      const fund = await prisma.hOFundReceipt.update({
        where: { id: req.params.id },
        data: {
          amount: amount !== undefined ? Number(amount) : undefined,
          receivedDate: receivedDate ? new Date(receivedDate) : undefined,
          notes: notes !== undefined ? (notes || null) : undefined,
        },
        include: { recordedBy: { select: employeeSelect } },
      });
      res.json({ success: true, data: fund });
    } catch (err) { next(err); }
  },

  async removeFund(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await prisma.hOFundReceipt.delete({ where: { id: req.params.id } });
      res.json({ success: true, message: 'Fund receipt deleted' });
    } catch (err) { next(err); }
  },

  // ── Vendors ─────────────────────────────────────────────────────────────
  // List is VIEW-level (anyone with finance-admin access can pick a vendor on
  // their own expense); create/update/remove are ADMIN-level (route-gated).
  async listVendors(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { status, search } = req.query;
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (search) where.name = { contains: String(search) };
      const vendors = await prisma.vendor.findMany({
        where,
        include: { createdBy: { select: employeeSelect } },
        orderBy: { name: 'asc' },
      });
      res.json({ success: true, data: vendors });
    } catch (err) { next(err); }
  },

  async createVendor(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { name, contactPerson, phone, email, address, gstNumber, panNumber, category, bankName, bankAccountNo, ifscCode, notes } = req.body;
      if (!name) throw new AppError('Vendor name is required', 400);
      const vendor = await prisma.vendor.create({
        data: {
          name, contactPerson, phone, email, address, gstNumber, panNumber, category,
          bankName, bankAccountNo, ifscCode, notes,
          createdById: req.user?.employeeId,
        },
      });
      res.status(201).json({ success: true, data: vendor });
    } catch (err) { next(err); }
  },

  async updateVendor(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { name, contactPerson, phone, email, address, gstNumber, panNumber, category, bankName, bankAccountNo, ifscCode, notes, status } = req.body;
      const vendor = await prisma.vendor.update({
        where: { id: req.params.id },
        data: { name, contactPerson, phone, email, address, gstNumber, panNumber, category, bankName, bankAccountNo, ifscCode, notes, status },
      });
      res.json({ success: true, data: vendor });
    } catch (err) { next(err); }
  },

  async removeVendor(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await prisma.vendor.delete({ where: { id: req.params.id } });
      res.json({ success: true, message: 'Vendor deleted' });
    } catch (err) { next(err); }
  },

  /** Vendor-wise spend, company-wide, ADMIN-only. */
  async vendorSummary(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { month, year } = req.query;
      const where: Record<string, unknown> = { vendorId: { not: null } };
      if (month || year) {
        const { start, end } = monthRange(month as string, year as string);
        where.expenseDate = { gte: start, lt: end };
      }
      const rows = await prisma.adminExpense.groupBy({ by: ['vendorId'], where, _sum: { amount: true }, _count: { _all: true } });
      const vendors = await prisma.vendor.findMany({ where: { id: { in: rows.map((r) => r.vendorId as string) } } });
      const data = rows
        .map((r) => {
          const v = vendors.find((x) => x.id === r.vendorId);
          return { vendorId: r.vendorId, vendorName: v?.name || 'Unknown', amount: r._sum.amount || 0, count: r._count._all };
        })
        .sort((a, b) => b.amount - a.amount);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  // ── Recurring Expense Templates ─────────────────────────────────────────
  async listRecurring(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const templates = await prisma.recurringExpenseTemplate.findMany({
        include: { createdBy: { select: employeeSelect } },
        orderBy: { title: 'asc' },
      });
      res.json({ success: true, data: templates });
    } catch (err) { next(err); }
  },

  async createRecurring(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { title, category, amount, vendorId, paymentMode, notes } = req.body;
      if (!title || !amount) throw new AppError('Title and amount are required', 400);
      const template = await prisma.recurringExpenseTemplate.create({
        data: {
          title, category, amount: Number(amount), vendorId: vendorId || undefined, paymentMode, notes,
          createdById: req.user?.employeeId,
        },
      });
      res.status(201).json({ success: true, data: template });
    } catch (err) { next(err); }
  },

  async updateRecurring(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { title, category, amount, vendorId, paymentMode, notes, isActive } = req.body;
      const template = await prisma.recurringExpenseTemplate.update({
        where: { id: req.params.id },
        data: {
          title, category,
          amount: amount !== undefined ? Number(amount) : undefined,
          vendorId: vendorId !== undefined ? (vendorId || null) : undefined,
          paymentMode, notes, isActive,
        },
      });
      res.json({ success: true, data: template });
    } catch (err) { next(err); }
  },

  async removeRecurring(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await prisma.recurringExpenseTemplate.delete({ where: { id: req.params.id } });
      res.json({ success: true, message: 'Recurring template deleted' });
    } catch (err) { next(err); }
  },

  /**
   * Stamp out a PENDING AdminExpense for the given month from every active
   * template, skipping templates that already have an expense generated for
   * that month (checked via recurringTemplateId + expenseDate range).
   */
  async generateRecurring(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { month, year } = req.body;
      const { start, end } = monthRange(month, year);
      const templates = await prisma.recurringExpenseTemplate.findMany({ where: { isActive: true } });

      const created = [];
      for (const t of templates) {
        const existing = await prisma.adminExpense.findFirst({
          where: { recurringTemplateId: t.id, expenseDate: { gte: start, lt: end } },
        });
        if (existing) continue;
        const expense = await prisma.adminExpense.create({
          data: {
            title: t.title,
            category: t.category,
            amount: t.amount,
            vendorId: t.vendorId,
            paymentMode: t.paymentMode,
            notes: t.notes,
            recurringTemplateId: t.id,
            expenseDate: start,
            requestedById: req.user?.employeeId,
          },
        });
        created.push(expense);
      }
      res.status(201).json({ success: true, data: created, message: `${created.length} expense(s) generated` });
    } catch (err) { next(err); }
  },

  // ─── Budgets: SUPER_ADMIN allots spending money to employees ────────────────
  // Running balance per employee = total allocated − total non-rejected expenses.

  // SUPER_ADMIN: full picture — per-employee summary + all allocation entries
  async budgetsSummary(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const [allocations, spentRows] = await Promise.all([
        prisma.budgetAllocation.findMany({
          include: {
            employee: { select: employeeSelect },
            allocatedBy: { select: employeeSelect },
          },
          orderBy: { allocatedDate: 'desc' },
        }),
        prisma.adminExpense.groupBy({
          by: ['requestedById'],
          where: { status: { not: 'REJECTED' }, requestedById: { not: null } },
          _sum: { amount: true },
        }),
      ]);

      const spentByEmp: Record<string, number> = {};
      for (const r of spentRows) if (r.requestedById) spentByEmp[r.requestedById] = r._sum.amount || 0;

      const byEmp: Record<string, { employee: unknown; allocated: number }> = {};
      for (const a of allocations) {
        if (!byEmp[a.employeeId]) byEmp[a.employeeId] = { employee: a.employee, allocated: 0 };
        byEmp[a.employeeId].allocated += a.amount;
      }

      const summary = Object.entries(byEmp).map(([empId, v]) => ({
        employeeId: empId,
        employee: v.employee,
        allocated: v.allocated,
        spent: spentByEmp[empId] || 0,
        balance: v.allocated - (spentByEmp[empId] || 0),
      })).sort((a, b) => a.balance - b.balance);

      res.json({ success: true, data: { summary, allocations } });
    } catch (err) { next(err); }
  },

  // Any spender: own budget position
  async myBudget(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const emp = await prisma.employee.findUnique({ where: { userId: req.user!.userId }, select: { id: true } });
      if (!emp) return res.json({ success: true, data: null });

      const [allocs, spent] = await Promise.all([
        prisma.budgetAllocation.findMany({
          where: { employeeId: emp.id },
          orderBy: { allocatedDate: 'desc' },
          select: { id: true, amount: true, notes: true, allocatedDate: true },
        }),
        prisma.adminExpense.aggregate({
          where: { requestedById: emp.id, status: { not: 'REJECTED' } },
          _sum: { amount: true },
        }),
      ]);

      const allocated = allocs.reduce((s: number, a: { amount: number }) => s + a.amount, 0);
      const spentAmt = spent._sum.amount || 0;
      res.json({
        success: true,
        data: allocs.length === 0
          ? null // no budget allotted yet — UI hides the strip
          : { allocated, spent: spentAmt, balance: allocated - spentAmt, allocations: allocs },
      });
    } catch (err) { next(err); }
  },

  // SUPER_ADMIN: allot budget
  async createBudget(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { employeeId, amount, notes, allocatedDate } = req.body;
      if (!employeeId) throw new AppError('employeeId is required', 400);
      if (!amount || Number(amount) <= 0) throw new AppError('A positive amount is required', 400);

      const alloc = await prisma.budgetAllocation.create({
        data: {
          employeeId,
          amount: Number(amount),
          notes: notes || null,
          allocatedDate: allocatedDate ? new Date(allocatedDate) : new Date(),
          allocatedById: req.user!.employeeId || null,
        },
        include: { employee: { select: employeeSelect } },
      });
      res.status(201).json({ success: true, data: alloc, message: 'Budget allotted' });
    } catch (err) { next(err); }
  },

  // SUPER_ADMIN: edit an allocation entry
  async updateBudget(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { amount, notes, allocatedDate } = req.body;
      if (amount !== undefined && Number(amount) <= 0) throw new AppError('Amount must be positive', 400);

      const alloc = await prisma.budgetAllocation.update({
        where: { id: req.params.id },
        data: {
          amount: amount !== undefined ? Number(amount) : undefined,
                 notes: notes !== undefined ? (notes || null) : undefined,
          allocatedDate: allocatedDate ? new Date(allocatedDate) : undefined,
        },
        include: { employee: { select: employeeSelect } },
      });
      res.json({ success: true, data: alloc });
    } catch (err) { next(err); }
  },

  // SUPER_ADMIN: remove an allocation entry
  async removeBudget(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await prisma.budgetAllocation.delete({ where: { id: req.params.id } });
      res.json({ success: true, message: 'Budget allocation deleted' });
    } catch (err) { next(err); }
  },
};
