'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Building2, Eye, EyeOff, Lock, Mail } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      router.push('/dashboard');
    }
  }

  async function handleDemoLogin() {
    setError('');
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: 'admin@sibuilding.com',
      password: 'Admin@123456',
    });
    if (error) {
      // Try to create demo account
      const { error: signUpError } = await supabase.auth.signUp({
        email: 'admin@sibuilding.com',
        password: 'Admin@123456',
        options: { data: { full_name: 'Admin User', role: 'super_admin' } },
      });
      if (signUpError) {
        setError('Demo login failed. Please create an account.');
        setLoading(false);
        return;
      }
      router.push('/dashboard');
    } else {
      router.push('/dashboard');
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="flex items-center gap-3 justify-center mb-8">
          <div className="w-12 h-12 bg-blue-500 rounded-xl flex items-center justify-center shadow-lg">
            <Building2 className="w-7 h-7 text-white" />
          </div>
          <div>
            <div className="text-white font-bold text-xl leading-tight">SI Building</div>
            <div className="text-blue-300 text-sm font-medium">Solutions ERP</div>
          </div>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-slate-900">Welcome back</h1>
            <p className="text-slate-500 text-sm mt-1">Sign in to your ERP account</p>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Email address
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@sibuilding.com"
                  required
                  className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  className="w-full pl-10 pr-10 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold py-2.5 rounded-lg transition duration-200 text-sm"
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>

          <div className="relative my-5">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-100" />
            </div>
            <div className="relative flex justify-center text-xs text-slate-400">
              <span className="bg-white px-2">or</span>
            </div>
          </div>

          <button
            onClick={handleDemoLogin}
            disabled={loading}
            className="w-full border-2 border-slate-200 hover:border-blue-300 hover:bg-blue-50 text-slate-700 font-semibold py-2.5 rounded-lg transition duration-200 text-sm"
          >
            Continue with Demo Account
          </button>

          <p className="text-xs text-slate-400 text-center mt-5">
            Demo: admin@sibuilding.com / Admin@123456
          </p>
        </div>

        <p className="text-center text-slate-400 text-xs mt-6">
          &copy; 2024 SI Building Solutions. All rights reserved.
        </p>
      </div>
    </div>
  );
}
