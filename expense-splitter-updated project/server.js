const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'PATCH'] }
});
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

const userSockets = new Map();

io.on('connection', (socket) => {
  socket.on('register', (userId) => {
    userSockets.set(userId, socket.id);
  });

  socket.on('disconnect', () => {
    for (let [userId, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        userSockets.delete(userId);
        break;
      }
    }
  });
});

const sendRealtimeNotification = (recipientId, notificationData) => {
  const socketId = userSockets.get(recipientId);
  if (socketId) {
    io.to(socketId).emit('notification', notificationData);
  }
};

// 1. Add Expense Route
app.post('/api/expenses', async (req, res) => {
  const { groupId, createdById, description, totalAmount, splitMethod, participants } = req.body;

  try {
    if (!description || totalAmount <= 0 || !participants || participants.length === 0) {
      return res.status(400).json({ error: 'Invalid input data' });
    }

    let calculatedTotal = 0;
    if (splitMethod === 'EQUAL') {
      const share = totalAmount / participants.length;
      participants.forEach(p => p.assignedAmount = share);
    } else if (splitMethod === 'PERCENTAGE') {
      const totalPct = participants.reduce((acc, p) => acc + p.percentage, 0);
      if (Math.abs(totalPct - 100) > 0.01) {
        return res.status(400).json({ error: 'Percentages must sum to 100%' });
      }
      participants.forEach(p => p.assignedAmount = (totalAmount * p.percentage) / 100);
    } else if (splitMethod === 'UNEQUAL') {
      calculatedTotal = participants.reduce((acc, p) => acc + p.assignedAmount, 0);
      if (Math.abs(calculatedTotal - totalAmount) > 0.01) {
        return res.status(400).json({ error: 'Assigned amounts must sum to total amount' });
      }
    }

    const creator = await prisma.user.findUnique({ where: { id: createdById } });

    const newExpense = await prisma.expense.create({
      data: {
        groupId,
        createdById,
        description,
        totalAmount,
        splitMethod,
        participants: {
          create: participants.map(p => ({
            userId: p.userId,
            assignedAmount: p.assignedAmount,
            percentage: p.percentage || null,
            acceptanceStatus: p.userId === createdById ? 'ACCEPTED' : 'PENDING'
          }))
        }
      },
      include: { participants: true }
    });

    for (const p of participants) {
      if (p.userId !== createdById) {
        const notif = await prisma.notification.create({
          data: {
            recipientId: p.userId,
            senderName: creator.name,
            type: 'NEW_EXPENSE',
            expenseId: newExpense.id,
            amount: p.assignedAmount,
            message: `${creator.name} added a new expense of ₹${totalAmount.toLocaleString()} for ${description}. Your share is ₹${p.assignedAmount.toLocaleString()}. Please review and accept your share.`
          }
        });
        sendRealtimeNotification(p.userId, notif);
      }
    }

    res.status(201).json(newExpense);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Accept / Reject Expense Share
app.patch('/api/expenses/:expenseId/respond', async (req, res) => {
  const { expenseId } = req.params;
  const { userId, status, reason } = req.body;

  try {
    const participant = await prisma.expenseParticipant.findUnique({
      where: { expenseId_userId: { expenseId, userId } },
      include: { expense: { include: { createdBy: true } }, user: true }
    });

    if (!participant) return res.status(404).json({ error: 'Participant record not found' });
    if (participant.acceptanceStatus !== 'PENDING') {
      return res.status(400).json({ error: 'Expense share already responded to' });
    }

    const updatedParticipant = await prisma.expenseParticipant.update({
      where: { id: participant.id },
      data: { acceptanceStatus: status, rejectionReason: reason || null }
    });

    const notifType = status === 'ACCEPTED' ? 'EXPENSE_ACCEPTED' : 'EXPENSE_REJECTED';
    const notifMessage = status === 'ACCEPTED'
      ? `${participant.user.name} accepted their share of ₹${participant.assignedAmount} for "${participant.expense.description}".`
      : `${participant.user.name} rejected their share for "${participant.expense.description}". Reason: ${reason || 'None provided'}`;

    const notif = await prisma.notification.create({
      data: {
        recipientId: participant.expense.createdById,
        senderName: participant.user.name,
        type: notifType,
        expenseId: participant.expenseId,
        amount: participant.assignedAmount,
        message: notifMessage
      }
    });

    sendRealtimeNotification(participant.expense.createdById, notif);

    res.json(updatedParticipant);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Independent Payment Endpoint
app.post('/api/payments', async (req, res) => {
  const { expenseParticipantId, payerId, payeeId, amountPaid } = req.body;

  try {
    const participant = await prisma.expenseParticipant.findUnique({
      where: { id: expenseParticipantId }
    });

    const newPayment = await prisma.payment.create({
      data: {
        expenseParticipantId,
        payerId,
        payeeId,
        amountPaid,
        status: amountPaid >= participant.assignedAmount ? 'PAID' : 'PARTIALLY_PAID'
      }
    });

    const payer = await prisma.user.findUnique({ where: { id: payerId } });

    const notif = await prisma.notification.create({
      data: {
        recipientId: payeeId,
        senderName: payer.name,
        type: 'PAYMENT_RECEIVED',
        amount: amountPaid,
        message: `${payer.name} paid you ₹${amountPaid.toLocaleString()}.`
      }
    });

    sendRealtimeNotification(payeeId, notif);

    res.status(201).json(newPayment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

server.listen(5000, () => console.log('Server running on port 5000'));
