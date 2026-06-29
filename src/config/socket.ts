import { Server } from 'socket.io';
import { Server as HttpServer } from 'http';
import { config } from './env';
import { verifyToken } from '../utils/jwt';

export let io: Server;

// userId -> Set of socketIds
const onlineUsers = new Map<string, Set<string>>();

export const initSocket = (httpServer: HttpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: config.FRONTEND_URL,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      const payload = verifyToken(token);
      (socket as any).user = payload;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const user = (socket as any).user;
    const userId: string = user.userId;

    // Track online
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId)!.add(socket.id);
    socket.join(`user:${userId}`);
    if (user.companyId) socket.join(`company:${user.companyId}`);
    socket.join(`role:${user.role}`);

    socket.broadcast.emit('user:online', { userId });

    socket.on('disconnect', () => {
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
          socket.broadcast.emit('user:offline', { userId });
        }
      }
    });

    socket.on('ping', () => socket.emit('pong'));
  });

  return io;
};

export const emitToUser = (userId: string, event: string, data: unknown) => {
  io?.to(`user:${userId}`).emit(event, data);
};

export const emitToRole = (role: string, event: string, data: unknown) => {
  io?.to(`role:${role}`).emit(event, data);
};

export const emitToCompany = (companyId: string, event: string, data: unknown) => {
  io?.to(`company:${companyId}`).emit(event, data);
};

export const isUserOnline = (userId: string) => onlineUsers.has(userId);
