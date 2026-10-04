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
            </Route>
          </Routes>
        </Router>
      </ThemeModeProvider>
    </AuthProvider>
  );
}

export default App;
