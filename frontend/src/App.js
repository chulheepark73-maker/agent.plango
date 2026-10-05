import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeModeProvider } from './contexts/ThemeModeContext';
import PrivateRoute from './components/PrivateRoute';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import IndicatorTrading from './pages/IndicatorTrading';
import TradingV21 from './pages/TradingV21';
import Settings from './pages/Settings';
import Report from './pages/Report';
import ServerRegistration from './pages/ServerRegistration';
import ComingSoon from './pages/ComingSoon';
import SubscriptionPlans from './pages/SubscriptionPlans';
import Profile from './pages/Profile';
import ChangePassword from './pages/ChangePassword';
import TelegramSettings from './pages/TelegramSettings';
import Layout from './components/Layout';

function App() {
  return (
    <AuthProvider>
      <ThemeModeProvider>
        <Router>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              path="/"
              element={
                <PrivateRoute>
                  <Layout />
                </PrivateRoute>
              }
            >
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard" element={<Dashboard />} />
              <Route path="indicator-trading" element={<IndicatorTrading />} />
              <Route path="trading-v2" element={<TradingV21 />} />
              <Route path="trading-v2-1" element={<Navigate to="/trading-v2" replace />} />
              <Route path="report" element={<Report />} />
              <Route path="settings" element={<Settings />} />
              <Route path="server-registration" element={<ServerRegistration />} />
              <Route path="server-management" element={<ComingSoon title="서버관리" />} />
              <Route path="subscription-plans" element={<SubscriptionPlans />} />
              <Route path="subscription-apply" element={<ComingSoon title="구독신청" />} />
              <Route path="profile" element={<Profile />} />
              <Route path="telegram-settings" element={<TelegramSettings />} />
              <Route path="change-password" element={<ChangePassword />} />
            </Route>
          </Routes>
        </Router>
      </ThemeModeProvider>
    </AuthProvider>
  );
}

export default App;
