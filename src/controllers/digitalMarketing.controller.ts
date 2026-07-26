import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';

const employeeSelect = { id: true, firstName: true, lastName: true, employeeCode: true };

type UploadedFiles = { [field: string]: Express.Multer.File[] } | undefined;

/** Aggregates recharges + daily reports into the "nook and corner" figures for one campaign. */
function computeCampaignTotals(
  recharges: { amount: number }[],
  dailyReports: { leadsReceived: number; leadsGivenToSales: number; leadsUploadedToCrm: number; amountSpent: number }[],
  legacySpent: number | null | undefined,
) {
  const totalRecharged = recharges.reduce((sum, r) => sum + r.amount, 0);
  const totalSpentFromReports = dailyReports.reduce((sum, r) => sum + r.amountSpent, 0);
  // Fall back to the legacy `spent` field only when no daily reports exist yet,
  // so older campaigns without daily-report history still show a sensible total.
  const totalSpent = dailyReports.length > 0 ? totalSpentFromReports : (legacySpent || 0);
  const totalLeadsReceived = dailyReports.reduce((sum, r) => sum + r.leadsReceived, 0);
  const totalLeadsGivenToSales = dailyReports.reduce((sum, r) => sum + r.leadsGivenToSales, 0);
  const totalLeadsUploadedToCrm = dailyReports.reduce((sum, r) => sum + r.leadsUploadedToCrm, 0);
  const overallCostPerLead = totalLeadsReceived > 0 ? totalSpent / totalLeadsReceived : null;
  const remainingBudget = totalRecharged - totalSpent;

  return {
    totalRecharged,
    totalSpent,
    remainingBudget,
    totalLeadsReceived,
    totalLeadsGivenToSales,
    totalLeadsUploadedToCrm,
    overallCostPerLead,
  };
}

export const digitalMarketingController = {
  async listCampaigns(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { status } = req.query;
      const where: Record<string, unknown> = {};
      if (status) where.status = status;

      const campaigns = await prisma.campaign.findMany({
        where,
        include: {
          owner: { select: employeeSelect },
          _count: { select: { leads: true, recharges: true, dailyReports: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: campaigns });
    } catch (err) { next(err); }
  },

  /** Full campaign detail: recharge history, daily reports, and computed totals. */
  async getCampaign(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const campaign = await prisma.campaign.findUnique({
        where: { id: req.params.id },
        include: {
          owner: { select: employeeSelect },
          closedBy: { select: employeeSelect },
          recharges: { include: { rechargedBy: { select: employeeSelect } }, orderBy: { rechargedAt: 'desc' } },
          dailyReports: { include: { reportedBy: { select: employeeSelect } }, orderBy: { date: 'desc' } },
        },
      });
      if (!campaign) throw new AppError('Campaign not found', 404);

      const totals = computeCampaignTotals(campaign.recharges, campaign.dailyReports, campaign.spent);
      const dailyReportsWithCpl = campaign.dailyReports.map((r) => ({
        ...r,
        costPerLead: r.leadsReceived > 0 ? r.amountSpent / r.leadsReceived : null,
      }));

      res.json({ success: true, data: { ...campaign, dailyReports: dailyReportsWithCpl, totals } });
    } catch (err) { next(err); }
  },

  /**
   * Creates a campaign. If an initial recharge amount is supplied, a bill copy
   * upload is mandatory and the first CampaignRecharge row is created alongside
   * the campaign — funds can't be on the books without an attached bill.
   */
  async createCampaign(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { name, channel, budget, startDate, endDate, ownerId, initialAmount, rechargedFor, note } = req.body;
      if (!name) throw new AppError('Name is required', 400);

      const amount = initialAmount !== undefined && initialAmount !== '' ? Number(initialAmount) : undefined;
      const billFile = req.file as Express.Multer.File | undefined;
      if (amount && amount > 0 && !billFile) {
        throw new AppError('A bill copy is required when recharging a campaign', 400);
      }

      const campaign = await prisma.$transaction(async (tx) => {
        const created = await tx.campaign.create({
          data: {
            name, channel,
            budget: budget !== undefined && budget !== '' ? Number(budget) : undefined,
            startDate: startDate ? new Date(startDate) : undefined,
            endDate: endDate ? new Date(endDate) : undefined,
            ownerId,
          },
        });

        if (amount && amount > 0 && billFile) {
          await tx.campaignRecharge.create({
            data: {
              campaignId: created.id,
              amount,
              rechargedFor: rechargedFor || channel,
              billUrl: `/uploads/campaigns/${billFile.filename}`,
              note,
              rechargedById: req.user?.employeeId,
            },
          });
        }

        return tx.campaign.findUnique({
          where: { id: created.id },
          include: { owner: { select: employeeSelect }, recharges: true },
        });
      });

      res.status(201).json({ success: true, data: campaign });
    } catch (err) { next(err); }
  },

  async updateCampaign(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { name, channel, status, budget, spent, startDate, endDate, ownerId } = req.body;
      const campaign = await prisma.campaign.update({
        where: { id: req.params.id },
        data: {
          name, channel, status, ownerId,
          budget: budget !== undefined ? Number(budget) : undefined,
          spent: spent !== undefined ? Number(spent) : undefined,
          startDate: startDate ? new Date(startDate) : undefined,
          endDate: endDate ? new Date(endDate) : undefined,
        },
        include: { owner: { select: employeeSelect } },
      });
      res.json({ success: true, data: campaign });
    } catch (err) { next(err); }
  },

  async remove(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await prisma.campaign.delete({ where: { id: req.params.id } });
      res.json({ success: true, message: 'Campaign deleted' });
    } catch (err) { next(err); }
  },

  // ── Recharges (initial funding + top-ups) — each requires its own bill copy ──

  async addRecharge(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
      if (!campaign) throw new AppError('Campaign not found', 404);
      if (campaign.status === 'COMPLETED') throw new AppError('Campaign is closed; cannot add funds', 400);

      const { amount, rechargedFor, note } = req.body;
      if (!amount || Number(amount) <= 0) throw new AppError('A positive amount is required', 400);

      const billFile = req.file as Express.Multer.File | undefined;
      if (!billFile) throw new AppError('A bill copy is required for every recharge', 400);

      const recharge = await prisma.campaignRecharge.create({
        data: {
          campaignId: campaign.id,
          amount: Number(amount),
          rechargedFor: rechargedFor || campaign.channel,
          billUrl: `/uploads/campaigns/${billFile.filename}`,
          note,
          rechargedById: req.user?.employeeId,
        },
        include: { rechargedBy: { select: employeeSelect } },
      });

      res.status(201).json({ success: true, data: recharge });
    } catch (err) { next(err); }
  },

  async listRecharges(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const recharges = await prisma.campaignRecharge.findMany({
        where: { campaignId: req.params.id },
        include: { rechargedBy: { select: employeeSelect } },
        orderBy: { rechargedAt: 'desc' },
      });
      res.json({ success: true, data: recharges });
    } catch (err) { next(err); }
  },

  /** Cross-campaign recharge ledger — every funding event across all campaigns, newest first. */
  async listAllRecharges(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { campaignId } = req.query;
      const where: Record<string, unknown> = {};
      if (campaignId) where.campaignId = campaignId;

      const recharges = await prisma.campaignRecharge.findMany({
        where,
        include: {
          rechargedBy: { select: employeeSelect },
          campaign: { select: { id: true, name: true, channel: true, status: true } },
        },
        orderBy: { rechargedAt: 'desc' },
      });
      res.json({ success: true, data: recharges });
    } catch (err) { next(err); }
  },

  // ── Daily reports: leads funnel + spend + optional dashboard screenshot ─────

  async upsertDailyReport(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
      if (!campaign) throw new AppError('Campaign not found', 404);
      if (campaign.status === 'COMPLETED') throw new AppError('Campaign is closed; cannot add reports', 400);

      const { date, leadsReceived, leadsGivenToSales, leadsUploadedToCrm, amountSpent, notes } = req.body;
      if (!date) throw new AppError('Date is required', 400);

      const reportDate = new Date(date);
      reportDate.setHours(0, 0, 0, 0);

      const dashboardFile = req.file as Express.Multer.File | undefined;
      const dashboardUrl = dashboardFile ? `/uploads/campaigns/${dashboardFile.filename}` : undefined;

      const existing = await prisma.campaignDailyReport.findUnique({
        where: { campaignId_date: { campaignId: campaign.id, date: reportDate } },
      });
      if (!dashboardUrl && !existing?.dashboardUrl) {
        throw new AppError('A dashboard screenshot is required as proof for every daily report', 400);
      }

      const data = {
        leadsReceived: leadsReceived !== undefined ? Number(leadsReceived) : 0,
        leadsGivenToSales: leadsGivenToSales !== undefined ? Number(leadsGivenToSales) : 0,
        leadsUploadedToCrm: leadsUploadedToCrm !== undefined ? Number(leadsUploadedToCrm) : 0,
        amountSpent: amountSpent !== undefined ? Number(amountSpent) : 0,
        notes,
        reportedById: req.user?.employeeId,
        ...(dashboardUrl ? { dashboardUrl } : {}),
      };

      const report = await prisma.campaignDailyReport.upsert({
        where: { campaignId_date: { campaignId: campaign.id, date: reportDate } },
        update: data,
        create: { campaignId: campaign.id, date: reportDate, ...data },
        include: { reportedBy: { select: employeeSelect } },
      });

      res.status(201).json({
        success: true,
        data: { ...report, costPerLead: report.leadsReceived > 0 ? report.amountSpent / report.leadsReceived : null },
      });
    } catch (err) { next(err); }
  },

  async listDailyReports(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const reports = await prisma.campaignDailyReport.findMany({
        where: { campaignId: req.params.id },
        include: { reportedBy: { select: employeeSelect } },
        orderBy: { date: 'desc' },
      });
      const withCpl = reports.map((r) => ({
        ...r,
        costPerLead: r.leadsReceived > 0 ? r.amountSpent / r.leadsReceived : null,
      }));
      res.json({ success: true, data: withCpl });
    } catch (err) { next(err); }
  },

  /** Cross-campaign daily report ledger — every day's leads/spend across all campaigns, newest first. */
  async listAllDailyReports(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { campaignId, from, to } = req.query;
      const where: Record<string, unknown> = {};
      if (campaignId) where.campaignId = campaignId;
      if (from || to) {
        where.date = {
          ...(from ? { gte: new Date(from as string) } : {}),
          ...(to ? { lte: new Date(to as string) } : {}),
        };
      }

      const reports = await prisma.campaignDailyReport.findMany({
        where,
        include: {
          reportedBy: { select: employeeSelect },
          campaign: { select: { id: true, name: true, channel: true, status: true } },
        },
        orderBy: { date: 'desc' },
      });
      const withCpl = reports.map((r) => ({
        ...r,
        costPerLead: r.leadsReceived > 0 ? r.amountSpent / r.leadsReceived : null,
      }));
      res.json({ success: true, data: withCpl });
    } catch (err) { next(err); }
  },

  // ── Closure: overall data rollup + expense sheet + ad-platform dashboard ────

  async closeCampaign(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const campaign = await prisma.campaign.findUnique({
        where: { id: req.params.id },
        include: { recharges: true, dailyReports: true },
      });
      if (!campaign) throw new AppError('Campaign not found', 404);
      if (campaign.status === 'COMPLETED') throw new AppError('Campaign is already closed', 400);

      const files = req.files as UploadedFiles;
      const expenseSheetFile = files?.expenseSheet?.[0];
      const dashboardFile = files?.dashboardScreenshot?.[0];
      if (!expenseSheetFile) throw new AppError('The overall expense sheet is required to close a campaign', 400);
      if (!dashboardFile) throw new AppError('The ad platform dashboard export is required to close a campaign', 400);

      const { closureSummary } = req.body;
      const totals = computeCampaignTotals(campaign.recharges, campaign.dailyReports, campaign.spent);

      const updated = await prisma.campaign.update({
        where: { id: campaign.id },
        data: {
          status: 'COMPLETED',
          closedAt: new Date(),
          closedById: req.user?.employeeId,
          closureSummary,
          closureExpenseSheetUrl: `/uploads/campaigns/${expenseSheetFile.filename}`,
          closureDashboardUrl: `/uploads/campaigns/${dashboardFile.filename}`,
          spent: totals.totalSpent,
        },
        include: {
          owner: { select: employeeSelect },
          closedBy: { select: employeeSelect },
          recharges: true,
          dailyReports: true,
        },
      });

      res.json({ success: true, data: { ...updated, totals } });
    } catch (err) { next(err); }
  },

  async stats(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const [activeCampaigns, closedCampaigns, totalBudget, totalSpent, totalLeadsSourced, totalRecharged, leadsFunnel] = await Promise.all([
        prisma.campaign.count({ where: { status: 'ACTIVE' } }),
        prisma.campaign.count({ where: { status: 'COMPLETED' } }),
        prisma.campaign.aggregate({ _sum: { budget: true } }),
        prisma.campaign.aggregate({ _sum: { spent: true } }),
        prisma.lead.count({ where: { campaignId: { not: null } } }),
        prisma.campaignRecharge.aggregate({ _sum: { amount: true } }),
        prisma.campaignDailyReport.aggregate({ _sum: { leadsReceived: true, leadsGivenToSales: true, leadsUploadedToCrm: true } }),
      ]);

      const spent = totalSpent._sum.spent || 0;
      const recharged = totalRecharged._sum.amount || 0;
      const leadsReceived = leadsFunnel._sum.leadsReceived || 0;

      res.json({
        success: true,
        data: {
          activeCampaigns,
          closedCampaigns,
          totalBudget: totalBudget._sum.budget || 0,
          totalSpent: spent,
          totalLeadsSourced,
          totalRecharged: recharged,
          remainingBudget: recharged - spent,
          overallCostPerLead: leadsReceived > 0 ? spent / leadsReceived : null,
          leadsReceived,
          leadsGivenToSales: leadsFunnel._sum.leadsGivenToSales || 0,
          leadsUploadedToCrm: leadsFunnel._sum.leadsUploadedToCrm || 0,
        },
      });
    } catch (err) { next(err); }
  },

  /**
   * Per-campaign lead quality: how many leads a campaign actually produced vs.
   * how many of those turned out to be workable. "Received"/"Given to Sales" come
   * from the marketing-entered CampaignDailyReport numbers; "Assigned"/"Not
   * Interested"/"Doesn't Work"/"Enrolled" come from the CRM Lead records
   * themselves (status + lostReason), which is where the sales team's actual
   * outcome per lead lives.
   */
  async leadQuality(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { status } = req.query;
      const campaignWhere: Record<string, unknown> = {};
      if (status) campaignWhere.status = status;

      const [campaigns, dailyTotals, statusCounts, reasonCounts, assignedCounts] = await Promise.all([
        prisma.campaign.findMany({
          where: campaignWhere,
          select: { id: true, name: true, channel: true, status: true },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.campaignDailyReport.groupBy({
          by: ['campaignId'],
          _sum: { leadsReceived: true, leadsGivenToSales: true },
        }),
        prisma.lead.groupBy({
          by: ['campaignId', 'status'],
          where: { campaignId: { not: null } },
          _count: { _all: true },
        }),
        prisma.lead.groupBy({
          by: ['campaignId', 'lostReason'],
          where: { campaignId: { not: null }, status: 'LOST' },
          _count: { _all: true },
        }),
        prisma.lead.groupBy({
          by: ['campaignId'],
          where: { campaignId: { not: null }, assignedToId: { not: null } },
          _count: { _all: true },
        }),
      ]);

      const dailyMap = new Map(dailyTotals.map((d) => [d.campaignId, d._sum]));
      const assignedMap = new Map(assignedCounts.map((r) => [r.campaignId as string, r._count._all]));

      const statusMap = new Map<string, Record<string, number>>();
      for (const row of statusCounts) {
        if (!row.campaignId) continue;
        const m = statusMap.get(row.campaignId) || {};
        m[row.status] = row._count._all;
        statusMap.set(row.campaignId, m);
      }

      const reasonMap = new Map<string, Record<string, number>>();
      for (const row of reasonCounts) {
        if (!row.campaignId) continue;
        const m = reasonMap.get(row.campaignId) || {};
        const key = row.lostReason || 'UNSPECIFIED';
        m[key] = row._count._all;
        reasonMap.set(row.campaignId, m);
      }

      const rows = campaigns.map((c) => {
        const statuses = statusMap.get(c.id) || {};
        const reasons = reasonMap.get(c.id) || {};
        const daily = dailyMap.get(c.id) || { leadsReceived: 0, leadsGivenToSales: 0 };
        const totalLeads = Object.values(statuses).reduce((s, n) => s + n, 0);
        const totalLost = statuses.LOST || 0;
        const notInterested = reasons.NOT_INTERESTED || 0;
        const doesntWork = totalLost - notInterested; // INVALID_NUMBER + UNREACHABLE + DUPLICATE + OTHER + UNSPECIFIED
        const enrolled = statuses.ENROLLED || 0;
        const leadsAssigned = assignedMap.get(c.id) || 0;
        const qualityPct = leadsAssigned > 0 ? ((leadsAssigned - totalLost) / leadsAssigned) * 100 : null;

        return {
          campaignId: c.id,
          campaignName: c.name,
          channel: c.channel,
          campaignStatus: c.status,
          leadsReceived: daily.leadsReceived || 0,
          leadsGivenToSales: daily.leadsGivenToSales || 0,
          leadsAssigned,
          totalLeads,
          notInterested,
          doesntWork,
          totalLost,
          enrolled,
          qualityPct,
        };
      });

      const overall = rows.reduce(
        (acc, r) => ({
          leadsReceived: acc.leadsReceived + r.leadsReceived,
          leadsGivenToSales: acc.leadsGivenToSales + r.leadsGivenToSales,
          leadsAssigned: acc.leadsAssigned + r.leadsAssigned,
          totalLeads: acc.totalLeads + r.totalLeads,
          notInterested: acc.notInterested + r.notInterested,
          doesntWork: acc.doesntWork + r.doesntWork,
          totalLost: acc.totalLost + r.totalLost,
          enrolled: acc.enrolled + r.enrolled,
        }),
        { leadsReceived: 0, leadsGivenToSales: 0, leadsAssigned: 0, totalLeads: 0, notInterested: 0, doesntWork: 0, totalLost: 0, enrolled: 0 }
      );
      const overallQualityPct = overall.leadsAssigned > 0 ? ((overall.leadsAssigned - overall.totalLost) / overall.leadsAssigned) * 100 : null;

      res.json({ success: true, data: { campaigns: rows, overall: { ...overall, qualityPct: overallQualityPct } } });
    } catch (err) { next(err); }
  },
};
