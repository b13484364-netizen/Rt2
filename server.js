const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// إعدادات الأمان والأداء
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// تخزين بيانات الغرف والمستخدمين
const rooms = new Map();
const userRooms = new Map();
const cleanupTimers = new Map();

// إحصائيات النظام
let totalRoomsCreated = 0;
let totalUsersConnected = 0;

// دالة إنشاء اسم مستخدم وهمي
function generateUsername(userCount) {
  const arabicNumbers = [
    'الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 
    'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر'
  ];
  
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
      console.log(`🧹 تنظيف الغرفة: ${roomKey}`);
      rooms.delete(roomKey);
      cleanupTimers.delete(roomKey);
    }
  }, 2 * 60 * 1000); // دقيقتان
  
  cleanupTimers.set(roomKey, timer);
  console.log(`⏰ جدولة تنظيف الغرفة ${roomKey} بعد دقيقتين`);
}

// دالة إلغاء تنظيف الغرفة
function cancelRoomCleanup(roomKey) {
  if (cleanupTimers.has(roomKey)) {
    clearTimeout(cleanupTimers.get(roomKey));
    cleanupTimers.delete(roomKey);
    console.log(`❌ إلغاء تنظيف الغرفة ${roomKey}`);
  }
}

// دالة التحقق من صحة الغرفة
function isRoomValid(roomKey) {
  const room = rooms.get(roomKey);
  if (!room) return false;
  
  const elapsed = Date.now() - room.startTime;
  return elapsed < room.duration;
}

// إدارة الاتصالات
io.on('connection', (socket) => {
  totalUsersConnected++;
  console.log(`🔗 مستخدم جديد متصل: ${socket.id} (إجمالي: ${totalUsersConnected})`);

  // الانضمام لغرفة
  socket.on('join-room', (data) => {
    try {
      const { roomKey, image, selectedDuration } = data;
      
      // التحقق من صحة البيانات
      if (!roomKey || !image || !selectedDuration) {
        socket.emit('join-error', { message: 'بيانات غير صحيحة' });
        return;
      }
      
      // التحقق من وجود الغرفة أو إنشاؤها
      if (!rooms.has(roomKey)) {
        totalRoomsCreated++;
        rooms.set(roomKey, {
          key: roomKey,
          image: image,
          users: new Map(),
          messages: [],
          startTime: Date.now(),
          duration: selectedDuration * 60 * 1000,
          extensions: 0,
          userCounter: 0,
          createdAt: new Date().toISOString()
        });
        console.log(`🏠 غرفة جديدة تم إنشاؤها: ${roomKey} (مدة: ${selectedDuration} دقيقة)`);
      }

      const room = rooms.get(roomKey);
      
      // التحقق من صحة الغرفة (الوقت)
      if (!isRoomValid(roomKey)) {
        socket.emit('room-expired', { 
          message: 'انتهت صلاحية هذه الغرفة',
          roomKey: roomKey 
        });
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
        joinTime: Date.now(),
        image: image
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
          extensions: room.extensions,
          userCount: room.users.size
        },
        user: room.users.get(socket.id)
      });

      // إعلام باقي المستخدمين بالانضمام
      socket.to(roomKey).emit('user-joined', {
        user: room.users.get(socket.id),
        totalUsers: room.users.size,
        userList: Array.from(room.users.values())
      });

      // رسالة نظام للانضمام
      const joinMessage = {
        id: Date.now(),
        text: `${username} انضم للمحادثة 👋`,
        timestamp: new Date(),
        type: 'text',
        sender: 'system'
      };
      
      room.messages.push(joinMessage);
      io.to(roomKey).emit('new-message', joinMessage);

      console.log(`👤 ${username} انضم للغرفة ${roomKey}. العدد الكلي: ${room.users.size}`);
      
    } catch (error) {
      console.error('خطأ في join-room:', error);
      socket.emit('join-error', { message: 'حدث خطأ أثناء الانضمام للغرفة' });
    }
  });

  // إرسال رسالة
  socket.on('send-message', (data) => {
    try {
      const roomKey = userRooms.get(socket.id);
      if (!roomKey || !rooms.has(roomKey)) {
        socket.emit('message-error', { message: 'غرفة غير موجودة' });
        return;
      }

      const room = rooms.get(roomKey);
      const user = room.users.get(socket.id);
      if (!user) {
        socket.emit('message-error', { message: 'مستخدم غير مصرح' });
        return;
      }

      // تنظيف النص من المحتوى الضار
      const cleanText = data.text.trim().substring(0, 1000); // حد أقصى 1000 حرف
      if (!cleanText) return;

      const message = {
        id: Date.now(),
        text: cleanText,
        timestamp: new Date(),
        type: 'text',
        sender: 'user',
        username: user.username,
        userId: socket.id
      };

      room.messages.push(message);
      
      // حد أقصى 500 رسالة لكل غرفة
      if (room.messages.length > 500) {
        room.messages = room.messages.slice(-400);
      }
      
      io.to(roomKey).emit('new-message', message);
      console.log(`💬 رسالة من ${user.username} في ${roomKey}: ${cleanText.substring(0, 50)}...`);
      
    } catch (error) {
      console.error('خطأ في send-message:', error);
      socket.emit('message-error', { message: 'فشل إرسال الرسالة' });
    }
  });

  // إرسال صورة
  socket.on('send-image', (data) => {
    try {
      const roomKey = userRooms.get(socket.id);
      if (!roomKey || !rooms.has(roomKey)) return;

      const room = rooms.get(roomKey);
      const user = room.users.get(socket.id);
      if (!user) return;

      // التحقق من صحة الصورة
      if (!data.imageUrl || !data.imageUrl.startsWith('data:image/')) {
        socket.emit('message-error', { message: 'صورة غير صحيحة' });
        return;
      }

      // التحقق من حجم الصورة (5MB كحد أقصى)
      const imageSizeInBytes = data.imageUrl.length * 0.75; // تقدير تقريبي
      if (imageSizeInBytes > 5 * 1024 * 1024) {
        socket.emit('message-error', { message: 'حجم الصورة كبير جداً' });
        return;
      }

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
      
      // حد أقصى للرسائل
      if (room.messages.length > 500) {
        room.messages = room.messages.slice(-400);
      }
      
      io.to(roomKey).emit('new-message', message);
      console.log(`🖼️ صورة من ${user.username} في ${roomKey}`);
      
    } catch (error) {
      console.error('خطأ في send-image:', error);
      socket.emit('message-error', { message: 'فشل إرسال الصورة' });
    }
  });

  // تمديد الوقت
  socket.on('extend-time', (data) => {
    try {
      const roomKey = userRooms.get(socket.id);
      if (!roomKey || !rooms.has(roomKey)) return;

      const room = rooms.get(roomKey);
      const user = room.users.get(socket.id);
      if (!user) return;

      let extensionText = '';
      
      if (data.type === 'add') {
        room.duration += 5 * 60 * 1000; // 5 دقائق
        room.extensions++;
        extensionText = `${user.username} أضاف 5 دقائق للوقت ⏰`;
        
      } else if (data.type === 'double') {
        const currentRemaining = room.duration - (Date.now() - room.startTime);
        if (currentRemaining > 0) {
          room.duration += currentRemaining;
          room.extensions++;
          extensionText = `${user.username} ضاعف الوقت المتبقي! 🚀`;
        } else {
          socket.emit('extension-error', { message: 'لا يمكن مضاعفة وقت منتهي' });
          return;
        }
      }
      
      const systemMessage = {
        id: Date.now(),
        text: extensionText,
        timestamp: new Date(),
        type: 'text',
        sender: 'system'
      };
      
      room.messages.push(systemMessage);
      io.to(roomKey).emit('new-message', systemMessage);
      io.to(roomKey).emit('time-extended', {
        type: data.type,
        newDuration: room.duration,
        extensions: room.extensions,
        by: user.username,
        remainingTime: room.duration - (Date.now() - room.startTime)
      });
      
      console.log(`⏰ ${extensionText} في الغرفة ${roomKey}`);
      
    } catch (error) {
      console.error('خطأ في extend-time:', error);
      socket.emit('extension-error', { message: 'فشل تمديد الوقت' });
    }
  });

  // مغادرة الغرفة يدوياً
  socket.on('leave-room', () => {
    handleUserDisconnect(socket.id, true);
  });

  // قطع الاتصال
  socket.on('disconnect', () => {
    handleUserDisconnect(socket.id, false);
  });

  // دالة معالجة مغادرة المستخدم
  function handleUserDisconnect(socketId, voluntary = false) {
    const roomKey = userRooms.get(socketId);
    if (roomKey && rooms.has(roomKey)) {
      const room = rooms.get(roomKey);
      const user = room.users.get(socketId);
      
      if (user) {
        // إزالة المستخدم من الغرفة
        room.users.delete(socketId);
        
        // رسالة نظام للمغادرة
        const leaveMessage = {
          id: Date.now(),
          text: `${user.username} ${voluntary ? 'غادر' : 'انقطع عن'} المحادثة 👋`,
          timestamp: new Date(),
          type: 'text',
          sender: 'system'
        };
        
        room.messages.push(leaveMessage);
        socket.to(roomKey).emit('new-message', leaveMessage);
        socket.to(roomKey).emit('user-left', {
          user: user,
          totalUsers: room.users.size,
          userList: Array.from(room.users.values())
        });

        console.log(`👋 ${user.username} ${voluntary ? 'غادر' : 'انقطع عن'} الغرفة ${roomKey}. العدد المتبقي: ${room.users.size}`);

        // إذا لم يبق أحد في الغرفة، جدول التنظيف
        if (room.users.size === 0) {
          scheduleRoomCleanup(roomKey);
        }
      }
    }
    
    userRooms.delete(socketId);
    
    if (!voluntary) {
      totalUsersConnected--;
      console.log(`🔌 مستخدم قطع الاتصال: ${socketId} (إجمالي: ${totalUsersConnected})`);
    }
    
    // إرسال تأكيد المغادرة
    socket.emit('left-room', { success: true });
  }
});

// الصفحة الرئيسية
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API للإحصائيات
app.get('/api/stats', (req, res) => {
  const activeRooms = Array.from(rooms.values()).map(room => ({
    key: room.key,
    users: room.users.size,
    messages: room.messages.length,
    duration: Math.floor(room.duration / 60000),
    extensions: room.extensions,
    createdAt: room.createdAt,
    timeRemaining: Math.max(0, room.duration - (Date.now() - room.startTime))
  }));

  res.json({
    totalRooms: rooms.size,
    totalActiveUsers: Array.from(rooms.values()).reduce((sum, room) => sum + room.users.size, 0),
    totalRoomsCreated: totalRoomsCreated,
    totalUsersConnected: totalUsersConnected,
    activeRooms: activeRooms,
    serverUptime: process.uptime(),
    memoryUsage: process.memoryUsage()
  });
});

// إحصائيات مبسطة
app.get('/stats', (req, res) => {
  res.json({
    activeRooms: rooms.size,
    activeUsers: Array.from(rooms.values()).reduce((sum, room) => sum + room.users.size, 0),
    totalCreated: totalRoomsCreated
  });
});

// صفحة الإحصائيات
app.get('/dashboard', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html dir="rtl" lang="ar">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>لوحة تحكم الخادم</title>
        <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-100 p-8">
        <div class="max-w-6xl mx-auto">
            <h1 class="text-3xl font-bold mb-8 text-center">لوحة تحكم تطبيق المحادثة الآمن</h1>
            <div id="stats" class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                <!-- الإحصائيات ستظهر هنا -->
            </div>
            <div id="rooms" class="bg-white rounded-lg shadow p-6">
                <h2 class="text-xl font-bold mb-4">الغرف النشطة</h2>
                <div id="roomsList">جاري التحميل...</div>
            </div>
        </div>
        
        <script>
            async function loadStats() {
                try {
                    const response = await fetch('/api/stats');
                    const data = await response.json();
                    
                    document.getElementById('stats').innerHTML = \`
                        <div class="bg-blue-500 text-white p-6 rounded-lg">
                            <h3 class="text-lg font-semibold">الغرف النشطة</h3>
                            <p class="text-3xl font-bold">\${data.totalRooms}</p>
                        </div>
                        <div class="bg-green-500 text-white p-6 rounded-lg">
                            <h3 class="text-lg font-semibold">المستخدمين النشطين</h3>
                            <p class="text-3xl font-bold">\${data.totalActiveUsers}</p>
                        </div>
                        <div class="bg-purple-500 text-white p-6 rounded-lg">
                            <h3 class="text-lg font-semibold">إجمالي الغرف المنشأة</h3>
                            <p class="text-3xl font-bold">\${data.totalRoomsCreated}</p>
                        </div>
                    \`;
                    
                    if (data.activeRooms.length > 0) {
                        document.getElementById('roomsList').innerHTML = data.activeRooms.map(room => \`
                            <div class="border-b py-4">
                                <div class="flex justify-between items-center">
                                    <div>
                                        <p class="font-semibold">الغرفة: \${room.key}</p>
                                        <p class="text-sm text-gray-600">\${room.users} مستخدمين - \${room.messages} رسالة</p>
                                    </div>
                                    <div class="text-left">
                                        <p class="text-sm">المدة: \${room.duration} دقيقة</p>
                                        <p class="text-sm">الوقت المتبقي: \${Math.floor(room.timeRemaining / 60000)} دقيقة</p>
                                    </div>
                                </div>
                            </div>
                        \`).join('');
                    } else {
                        document.getElementById('roomsList').innerHTML = '<p class="text-gray-500">لا توجد غرف نشطة حالياً</p>';
                    }
                } catch (error) {
                    console.error('خطأ في تحميل الإحصائيات:', error);
                }
            }
            
            loadStats();
            setInterval(loadStats, 5000); // تحديث كل 5 ثوان
        </script>
    </body>
    </html>
  `);
});

// معالج الأخطاء
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'حدث خطأ في الخادم' });
});

// تنظيف دوري للغرف المنتهية الصلاحية
setInterval(() => {
  const now = Date.now();
  let cleanedRooms = 0;
  
  for (const [roomKey, room] of rooms.entries()) {
    const elapsed = now - room.startTime;
    if (elapsed >= room.duration && room.users.size === 0) {
      console.log(`🧹 تنظيف غرفة منتهية الصلاحية: ${roomKey}`);
      rooms.delete(roomKey);
      if (cleanupTimers.has(roomKey)) {
        clearTimeout(cleanupTimers.get(roomKey));
        cleanupTimers.delete(roomKey);
      }
      cleanedRooms++;
    }
  }
  
  if (cleanedRooms > 0) {
    console.log(`🧹 تم تنظيف ${cleanedRooms} غرفة منتهية الصلاحية`);
  }
}, 30000); // تحقق كل 30 ثانية

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 الخادم يعمل على المنفذ ${PORT}`);
  console.log(`📱 افتح المتصفح على: http://localhost:${PORT}`);
  console.log(`📊 لوحة التحكم: http://localhost:${PORT}/dashboard`);
  console.log(`📈 الإحصائيات: http://localhost:${PORT}/api/stats`);
});

// معالجة إيقاف الخادم بأمان
process.on('SIGTERM', () => {
  console.log('🛑 إيقاف الخادم...');
  server.close(() => {
    console.log('✅ تم إيقاف الخادم بأمان');
    process.exit(0);
  });
});
