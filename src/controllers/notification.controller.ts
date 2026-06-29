import { Response, NextFunction } from 'express';
import { notificationService } from '../services/notification.service';
import { birthdayService } from '../services/birthday.service';
import { AuthRequest } from '../types';

export const notificationController = {
  async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 20 } = req.query;
      const result = await notificationService.getByUser(req.user!.userId, Number(page), Number(limit));
      res.json({ success: true, ...result });
    } catch (err) { next(err); }
  },

  async unreadCount(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const count = await notificationService.getUnreadCount(req.user!.userId);
      res.json({ success: true, data: { count } });
    } catch (err) { next(err); }
  },

  async markRead(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await notificationService.markAsRead(req.params.id, req.user!.userId);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async markAllRead(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await notificationService.markAllAsRead(req.user!.userId);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // Manual trigger for testing the automated birthday email/notification job
  async triggerBirthdayCheck(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const result = await birthdayService.sendTodaysBirthdayWishes();
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },
};
