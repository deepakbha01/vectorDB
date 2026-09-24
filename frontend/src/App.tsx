import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { DashboardPage } from './pages/DashboardPage';
import { ProjectCreatePage } from './pages/ProjectCreatePage';
import { PatternLibraryPage } from './pages/PatternLibraryPage';
import { VectorDbSelectionPage } from './pages/VectorDbSelectionPage';
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
import { InferencePage } from './pages/InferencePage';
import { AiFactoryPage } from './pages/AiFactoryPage';
import { WorkloadProfilePage } from './pages/WorkloadProfilePage';
import { ModelSelectionPage } from './pages/ModelSelectionPage';
import { InferenceArchitecturePage } from './pages/InferenceArchitecturePage';
import { InfrastructureDesignPage } from './pages/InfrastructureDesignPage';
import { RagAgentPage } from './pages/RagAgentPage';
import { SecurityGovernancePage } from './pages/SecurityGovernancePage';

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        <Route element={<ProtectedRoute />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/admin/users" element={<UsersManagementPage />} />
          <Route path="/patterns" element={<PatternLibraryPage />} />
          <Route path="/projects/new" element={<ProjectCreatePage />} />
          <Route path="/projects/:id/discovery" element={<DiscoveryPage />} />
          <Route path="/projects/:id/data-pipeline" element={<DataPipelineDesignPage />} />
          <Route path="/projects/:id/index-design" element={<IndexDesignPage />} />
          <Route path="/projects/:id/vector-db-selection" element={<VectorDbSelectionPage />} />
          <Route path="/projects/:id/deployment" element={<DeploymentPage />} />
          <Route path="/projects/:id/ingestion" element={<IngestionPage />} />
          <Route path="/projects/:id/optimization" element={<OptimizationPage />} />
          <Route path="/projects/:id/capacity" element={<CapacityPage />} />
          <Route path="/projects/:id/reports" element={<ReportsPage />} />
          <Route path="/projects/:id/audit-log" element={<AuditLogPage />} />
          <Route path="/projects/:id/inference" element={<InferencePage />} />
          <Route path="/projects/:id/ai-factory" element={<AiFactoryPage />} />
          <Route path="/projects/:id/workload-profile" element={<WorkloadProfilePage />} />
          <Route path="/projects/:id/model-selection" element={<ModelSelectionPage />} />
          <Route path="/projects/:id/inference-architecture" element={<InferenceArchitecturePage />} />
          <Route path="/projects/:id/infrastructure-design" element={<InfrastructureDesignPage />} />
          <Route path="/projects/:id/rag-agent" element={<RagAgentPage />} />
          <Route path="/projects/:id/security-governance" element={<SecurityGovernancePage />} />
        </Route>

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </AuthProvider>
  );
}
