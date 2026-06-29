import prisma from '../config/database';
import { emitToUser } from '../config/socket';
import { NotificationType, Prisma } from '@prisma/client';

interface CreateNotificationDto {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  data?: Record<string, unknown>;
}

export const notificationService = {
  async create(dto: CreateNotificationDto) {
    const notification = await prisma.notification.create({
      data: { ...dto, data: dto.data as Prisma.InputJsonValue },
    });

    // Real-time push
    emitToUser(dto.userId, 'notification', {
      id: notification.id,
      type: dto.type,
      title: dto.title,
      message: dto.message,
      data: dto.data,
      isRead: false,
      createdAt: notification.createdAt,
    });

    return notification;
  },

  async getByUser(userId: string, page = 1, limit = 20) {
    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.notification.count({ where: { userId } }),
    ]);
    return { notifications, total };
  },

  async getUnreadCount(userId: string) {
    return prisma.notification.count({ where: { userId, isRead: false } });
  },

  async markAsRead(id: string, userId: string) {
    return prisma.notification.updateMany({
      where: { id, userId },
      data: { isRead: true, readAt: new Date() },
    });
  },

  async markAllAsRead(userId: string) {
    return prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
  },

  async bulkCreate(userIds: string[], dto: Omit<CreateNotificationDto, 'userId'>) {
    const created = await Promise.all(
      userIds.map((userId) => this.create({ ...dto, userId }))
    );
    return created;
  },
};
