import { createContext, ReactNode, useContext, useMemo, useState } from 'react';
import { apiClient, ApiUser } from '../api/client';

interface AuthContextValue {
  user: ApiUser | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, fullName?: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function readStoredUser(): ApiUser | null {
  const raw = localStorage.getItem('user');
  return raw ? (JSON.parse(raw) as ApiUser) : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<ApiUser | null>(readStoredUser());

  const persistSession = (accessToken: string, sessionUser: ApiUser) => {
    localStorage.setItem('accessToken', accessToken);
    localStorage.setItem('user', JSON.stringify(sessionUser));
    setUser(sessionUser);
  };

  const login = async (email: string, password: string) => {
    const { data } = await apiClient.post('/auth/login', { email, password });
    persistSession(data.accessToken, data.user);
  };

  const register = async (email: string, password: string, fullName?: string) => {
    const { data } = await apiClient.post('/auth/register', { email, password, fullName });
    persistSession(data.accessToken, data.user);
  };

  const logout = () => {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('user');
    setUser(null);
  };

  const value = useMemo(() => ({ user, login, register, logout }), [user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
