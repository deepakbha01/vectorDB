import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { DashboardPage } from './pages/DashboardPage';
import { ProjectCreatePage } from './pages/ProjectCreatePage';
import { PlatformSelectionPage } from './pages/PlatformSelectionPage';
import { DiscoveryPage } from './pages/DiscoveryPage';
import { DataPipelineDesignPage } from './pages/DataPipelineDesignPage';
import { IndexDesignPage } from './pages/IndexDesignPage';
import { DeploymentPage } from './pages/DeploymentPage';
import { IngestionPage } from './pages/IngestionPage';
import { OptimizationPage } from './pages/OptimizationPage';
import { CapacityPage } from './pages/CapacityPage';
import { ReportsPage } from './pages/ReportsPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { UsersManagementPage } from './pages/UsersManagementPage';

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        <Route element={<ProtectedRoute />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/admin/users" element={<UsersManagementPage />} />
          <Route path="/projects/new" element={<ProjectCreatePage />} />
          <Route path="/projects/:id/discovery" element={<DiscoveryPage />} />
          <Route path="/projects/:id/data-pipeline" element={<DataPipelineDesignPage />} />
          <Route path="/projects/:id/index-design" element={<IndexDesignPage />} />
          <Route path="/projects/:id/deployment" element={<DeploymentPage />} />
          <Route path="/projects/:id/ingestion" element={<IngestionPage />} />
          <Route path="/projects/:id/optimization" element={<OptimizationPage />} />
          <Route path="/projects/:id/capacity" element={<CapacityPage />} />
          <Route path="/projects/:id/reports" element={<ReportsPage />} />
          <Route path="/projects/:id/audit-log" element={<AuditLogPage />} />
          <Route path="/projects/:id/platform" element={<PlatformSelectionPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </AuthProvider>
  );
}
