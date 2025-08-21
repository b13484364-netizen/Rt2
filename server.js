const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// إعدادات الأمان
app.use(helmet({
  contentSecurityPolicy: false // تعطيل CSP للسماح بـ inline scripts
}));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// تخزين بيانات الغرف والمستخدمين
const rooms = new Map();
const userRooms = new Map(); // ربط socket.id بـ roomKey
const cleanupTimers = new Map(); // مؤقتات تنظيف الغرف

// دالة إنشاء اسم مستخدم وهمي
function generateUsername(userCount) {
  const arabicNumbers = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر'];
  if (userCount <= 10) {
    return `المستخدم ${arabicNumbers[userCount - 1]}`;
  }
  return `المستخدم رقم ${userCount}`;
}

// دالة تنظيف الغرفة الفارغة
function scheduleRoomCleanup(roomKey) {
  // إلغاء أي مؤقت سابق
  if (cleanupTimers.has(roomKey)) {
    clearTimeout(cleanupTimers.get(roomKey));
  }
  
  // جدولة تنظيف بعد دقيقتين
  const timer = setTimeout(() => {
    const room = rooms.get(roomKey);
    if (room && room.users.size === 0) {
      console.log(`تنظيف الغرفة: ${roomKey}`);
      rooms.delete(roomKey);
      cleanupTimers.delete(roomKey);
    }
  }, 2 * 60 * 1000); // دقيقتان
  
  cleanupTimers.set(roomKey, timer);
}

// دالة إلغاء تنظيف الغرفة
function cancelRoomCleanup(roomKey) {
  if (cleanupTimers.has(roomKey)) {
    clearTimeout(cleanupTimers.get(roomKey));
    cleanupTimers.delete(roomKey);
  }
}

// إدارة الاتصالات
io.on('connection', (socket) => {
  console.log('مستخدم جديد متصل:', socket.id);

  // الانضمام لغرفة
  socket.on('join-room', (data) => {
    const { roomKey, image, selectedDuration } = data;
    
    // التحقق من وجود الغرفة أو إنشاؤها
    if (!rooms.has(roomKey)) {
      rooms.set(roomKey, {
        key: roomKey,
        image: image,
        users: new Map(),
        messages: [],
        startTime: Date.now(),
        duration: selectedDuration * 60 * 1000,
        extensions: 0,
        userCounter: 0
      });
      console.log(`غرفة جديدة تم إنشاؤها: ${roomKey}`);
    }

    const room = rooms.get(roomKey);
    
    // التحقق من صحة الغرفة (الوقت)
    const elapsed = Date.now() - room.startTime;
    if (elapsed >= room.duration) {
      socket.emit('room-expired');
      return;
    }

    // إلغاء تنظيف الغرفة إذا كان مجدولاً
    cancelRoomCleanup(roomKey);

    // إضافة المستخدم للغرفة
    room.userCounter++;
    const username = generateUsername(room.userCounter);
    
    room.users.set(socket.id, {
      id: socket.id,
      username: username,
      joinTime: Date.now()
    });

    userRooms.set(socket.id, roomKey);
    socket.join(roomKey);

    // إرسال بيانات الغرفة للمستخدم الجديد
    socket.emit('room-joined', {
      success: true,
      room: {
        key: roomKey,
        image: room.image,
        messages: room.messages,
        users: Array.from(room.users.values()),
        startTime: room.startTime,
        duration: room.duration,
        extensions: room.extensions
      },
      user: room.users.get(socket.id)
    });

    // إعلام باقي المستخدمين بالانضمام
    socket.to(roomKey).emit('user-joined', {
      user: room.users.get(socket.id),
      totalUsers: room.users.size
    });

    // رسالة نظام للانضمام
    const joinMessage = {
      id: Date.now(),
      text: `${username} انضم للمحادثة`,
      timestamp: new Date(),
      type: 'text',
      sender: 'system'
    };
    
    room.messages.push(joinMessage);
    io.to(roomKey).emit('new-message', joinMessage);

    console.log(`${username} انضم للغرفة ${roomKey}. العدد الكلي: ${room.users.size}`);
  });

  // إرسال رسالة
  socket.on('send-message', (data) => {
    const roomKey = userRooms.get(socket.id);
    if (!roomKey || !rooms.has(roomKey)) return;

    const room = rooms.get(roomKey);
    const user = room.users.get(socket.id);
    if (!user) return;

    const message = {
      id: Date.now(),
      text: data.text,
      timestamp: new Date(),
      type: 'text',
      sender: 'user',
      username: user.username,
      userId: socket.id
    };

    room.messages.push(message);
    io.to(roomKey).emit('new-message', message);
  });

  // إرسال صورة
  socket.on('send-image', (data) => {
    const roomKey = userRooms.get(socket.id);
    if (!roomKey || !rooms.has(roomKey)) return;

    const room = rooms.get(roomKey);
    const user = room.users.get(socket.id);
    if (!user) return;

    const message = {
      id: Date.now(),
      imageUrl: data.imageUrl,
      timestamp: new Date(),
      type: 'image',
      sender: 'user',
      username: user.username,
      userId: socket.id
    };

    room.messages.push(message);
    io.to(roomKey).emit('new-message', message);
  });

  // تمديد الوقت
  socket.on('extend-time', (data) => {
    const roomKey = userRooms.get(socket.id);
    if (!roomKey || !rooms.has(roomKey)) return;

    const room = rooms.get(roomKey);
    const user = room.users.get(socket.id);
    if (!user) return;

    if (data.type === 'add') {
      room.duration += 5 * 60 * 1000; // 5 دقائق
      room.extensions++;
      
      const systemMessage = {
        id: Date.now(),
        text: `${user.username} أضاف 5 دقائق للوقت ⏰`,
        timestamp: new Date(),
        type: 'text',
        sender: 'system'
      };
      
      room.messages.push(systemMessage);
      io.to(roomKey).emit('new-message', systemMessage);
      io.to(roomKey).emit('time-extended', {
        type: 'add',
        newDuration: room.duration,
        extensions: room.extensions,
        by: user.username
      });
      
    } else if (data.type === 'double') {
      const currentRemaining = room.duration - (Date.now() - room.startTime);
      if (currentRemaining > 0) {
        room.duration += currentRemaining;
        room.extensions++;
        
        const systemMessage = {
          id: Date.now(),
          text: `${user.username} ضاعف الوقت المتبقي! 🚀`,
          timestamp: new Date(),
          type: 'text',
          sender: 'system'
        };
        
        room.messages.push(systemMessage);
        io.to(roomKey).emit('new-message', systemMessage);
        io.to(roomKey).emit('time-extended', {
          type: 'double',
          newDuration: room.duration,
          extensions: room.extensions,
          by: user.username
        });
      }
    }
  });

  // قطع الاتصال
  socket.on('disconnect', () => {
    const roomKey = userRooms.get(socket.id);
    if (roomKey && rooms.has(roomKey)) {
      const room = rooms.get(roomKey);
      const user = room.users.get(socket.id);
      
      if (user) {
        // إزالة المستخدم من الغرفة
        room.users.delete(socket.id);
        
        // رسالة نظام للمغادرة
        const leaveMessage = {
          id: Date.now(),
          text: `${user.username} غادر المحادثة`,
          timestamp: new Date(),
          type: 'text',
          sender: 'system'
        };
        
        room.messages.push(leaveMessage);
        socket.to(roomKey).emit('new-message', leaveMessage);
        socket.to(roomKey).emit('user-left', {
          user: user,
          totalUsers: room.users.size
        });

        console.log(`${user.username} غادر الغرفة ${roomKey}. العدد المتبقي: ${room.users.size}`);

        // إذا لم يبق أحد في الغرفة، جدول التنظيف
        if (room.users.size === 0) {
          scheduleRoomCleanup(roomKey);
        }
      }
    }
    
    userRooms.delete(socket.id);
    console.log('مستخدم قطع الاتصال:', socket.id);
  });

  // مغادرة الغرفة يدوياً
  socket.on('leave-room', () => {
    const roomKey = userRooms.get(socket.id);
    if (roomKey && rooms.has(roomKey)) {
      const room = rooms.get(roomKey);
      const user = room.users.get(socket.id);
      
      if (user) {
        room.users.delete(socket.id);
        socket.leave(roomKey);
        
        const leaveMessage = {
          id: Date.now(),
          text: `${user.username} غادر المحادثة`,
          timestamp: new Date(),
          type: 'text',
          sender: 'system'
        };
        
        room.messages.push(leaveMessage);
        socket.to(roomKey).emit('new-message', leaveMessage);
        socket.to(roomKey).emit('user-left', {
          user: user,
          totalUsers: room.users.size
        });

        if (room.users.size === 0) {
          scheduleRoomCleanup(roomKey);
        }
      }
    }
    
    userRooms.delete(socket.id);
    socket.emit('left-room');
  });
});

// الصفحة الرئيسية
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// إحصائيات (اختياري للمطورين)
app.get('/stats', (req, res) => {
  res.json({
    totalRooms: rooms.size,
    totalUsers: Array.from(rooms.values()).reduce((sum, room) => sum + room.users.size, 0),
    rooms: Array.from(rooms.values()).map(room => ({
      key: room.key,
      users: room.users.size,
      messages: room.messages.length,
      duration: Math.floor(room.duration / 60000),
      extensions: room.extensions
    }))
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 الخادم يعمل على المنفذ ${PORT}`);
  console.log(`📱 افتح المتصفح على: http://localhost:${PORT}`);
});

// تنظيف دوري للغرف المنتهية الصلاحية
setInterval(() => {
  const now = Date.now();
  for (const [roomKey, room] of rooms.entries()) {
    const elapsed = now - room.startTime;
    if (elapsed >= room.duration && room.users.size === 0) {
      console.log(`تنظيف غرفة منتهية الصلاحية: ${roomKey}`);
      rooms.delete(roomKey);
      if (cleanupTimers.has(roomKey)) {
        clearTimeout(cleanupTimers.get(roomKey));
        cleanupTimers.delete(roomKey);
      }
    }
  }
}, 30000); // تحقق كل 30 ثانية
