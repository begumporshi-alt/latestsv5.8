'use client';

import { usePathname } from 'next/navigation';
import { ShieldOff } from 'lucide-react';
import { canAccessRoute } from '@/lib/permissions';
import { useProfile } from '@/hooks/use-profile';

// Blocks direct-URL access to modules the caller's role may not open.
// Fails open while the profile loads or can't be fetched (offline).
export default function RoleRouteGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { profile, loading } = useProfile();

  if (loading || !profile || canAccessRoute(profile.role, pathname, profile.moduleOverrides)) {
    return <>{children}</>;
  }

  return (
    <div className="flex flex-col items-center justify-center h-[60vh] text-center animate-fade-in">
      <div className="w-14 h-14 rounded-2xl bg-red-50 border border-red-200 flex items-center justify-center mb-4">
        <ShieldOff className="w-7 h-7 text-red-500" />
      </div>
      <h1 className="text-lg font-bold text-foreground">No access to this module</h1>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">
        Your role ({profile.role.replace(/_/g, ' ')}) does not include this area. Ask an
        administrator if you believe you should have access.
      </p>
    </div>
  );
}
