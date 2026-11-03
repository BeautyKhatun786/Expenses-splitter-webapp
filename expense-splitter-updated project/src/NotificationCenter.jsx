import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import axios from 'axios';

const socket = io('http://localhost:5000');

export default function NotificationCenter({ currentUserId }) {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    socket.emit('register', currentUserId);

    axios.get(`/api/notifications/${currentUserId}`).then((res) => {
      setNotifications(res.data);
      setUnreadCount(res.data.filter((n) => !n.isRead).length);
    });

    socket.on('notification', (newNotif) => {
      setNotifications((prev) => [newNotif, ...prev]);
      setUnreadCount((prev) => prev + 1);
    });

    return () => {
      socket.off('notification');
    };
  }, [currentUserId]);

  const handleResponse = async (expenseId, status, reason = '') => {
    try {
      await axios.patch(`/api/expenses/${expenseId}/respond`, {
        userId: currentUserId,
        status,
        reason
      });

      setNotifications((prev) =>
        prev.map((n) =>
          n.expenseId === expenseId ? { ...n, responded: true, statusAction: status } : n
        )
      );
    } catch (err) {
      alert(err.response?.data?.error || 'Action failed');
    }
  };

  return (
    <div className="notification-center">
      <div className="header">
        <h3>Notifications</h3>
        {unreadCount > 0 && <span className="badge">{unreadCount}</span>}
      </div>

      <div className="notification-list">
        {notifications.length === 0 ? (
          <p className="empty-state">No notifications yet.</p>
        ) : (
          notifications.map((n) => (
            <div key={n.id} className={`notif-card ${!n.isRead ? 'unread' : ''}`}>
              <p>{n.message}</p>
              <span className="time">{new Date(n.createdAt).toLocaleString()}</span>

              {n.type === 'NEW_EXPENSE' && !n.responded && (
                <div className="actions">
                  <button
                    className="btn-accept"
                    onClick={() => handleResponse(n.expenseId, 'ACCEPTED')}
                  >
                    Accept
                  </button>
                  <button
                    className="btn-reject"
                    onClick={() => {
                      const reason = prompt('Enter rejection reason:');
                      if (reason) handleResponse(n.expenseId, 'REJECTED', reason);
                    }}
                  >
                    Reject
                  </button>
                  <button className="btn-details">View Details</button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
