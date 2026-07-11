import { Routes, Route } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

// Placeholder shell only — role-gated routes (/admin/*, /t/*) get real pages in
// 04f. This just proves the single-app, role-gated-route topology boots.
function Placeholder({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <Placeholder
            title="ad-server"
            description="Foundation build (04a) complete. Auth, campaign/screen CRUD, and the reconciliation engine land in later build phases."
          />
        }
      />
      <Route
        path="/admin/*"
        element={<Placeholder title="Superadmin console" description="Coming in 04f." />}
      />
      <Route
        path="/t/*"
        element={<Placeholder title="Tenant dashboard" description="Coming in 04f." />}
      />
    </Routes>
  );
}
