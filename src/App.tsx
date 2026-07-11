import { Routes, Route, Navigate } from 'react-router-dom';
import { RequireRole } from '@/components/RequireRole';
import { TenantLayout } from '@/components/layout/TenantLayout';
import { AdminLayout } from '@/components/layout/AdminLayout';
import Login from '@/pages/Login';
import InviteAccept from '@/pages/InviteAccept';
import CampaignsList from '@/pages/tenant/CampaignsList';
import CampaignForm from '@/pages/tenant/CampaignForm';
import ScreensList from '@/pages/tenant/ScreensList';
import Usage from '@/pages/tenant/Usage';
import Settings from '@/pages/tenant/Settings';
import TenantsList from '@/pages/admin/TenantsList';
import TenantNew from '@/pages/admin/TenantNew';
import TenantDetail from '@/pages/admin/TenantDetail';
import Ledger from '@/pages/admin/Ledger';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/invite" element={<InviteAccept />} />

      <Route path="/t" element={<RequireRole role="tenant_admin" />}>
        <Route element={<TenantLayout />}>
          <Route index element={<Navigate to="campaigns" replace />} />
          <Route path="campaigns" element={<CampaignsList />} />
          <Route path="campaigns/new" element={<CampaignForm />} />
          <Route path="campaigns/:id/edit" element={<CampaignForm />} />
          <Route path="screens" element={<ScreensList />} />
          <Route path="usage" element={<Usage />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Route>

      <Route path="/admin" element={<RequireRole role="superadmin" />}>
        <Route element={<AdminLayout />}>
          <Route index element={<Navigate to="tenants" replace />} />
          <Route path="tenants" element={<TenantsList />} />
          <Route path="tenants/new" element={<TenantNew />} />
          <Route path="tenants/:id" element={<TenantDetail />} />
          <Route path="ledger" element={<Ledger />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}
