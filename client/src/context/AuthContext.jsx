import { createContext, useState, useRef, useEffect, useCallback } from 'react';
import api from '../services/api';

export const AuthContext = createContext();

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const accessTokenRef = useRef(null);

  const setAccessToken = (token) => {
    accessTokenRef.current = token;
  };

  const fetchMe = useCallback(async () => {
    try {
      const res = await api.get('/auth/me', { withCredentials: true });
      setUser(res.data.user || res.data);
      return res.data;
    } catch {
      return null;
    }
  }, []);

  const refreshToken = useCallback(async () => {
    try {
      const res = await api.post('/auth/refresh', {}, { withCredentials: true });
      setAccessToken(res.data.accessToken);
      setUser(res.data.user);
      return res.data.accessToken;
    } catch {
      setUser(null);
      setAccessToken(null);
      return null;
    }
  }, []);

  useEffect(() => {
    const reqInterceptor = api.interceptors.request.use((config) => {
      if (accessTokenRef.current) {
        config.headers.Authorization = `Bearer ${accessTokenRef.current}`;
      }
      return config;
    });

    const resInterceptor = api.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;
        if (error.response?.status === 401 && !originalRequest._retry) {
          originalRequest._retry = true;
          const newToken = await refreshToken();
          if (newToken) {
            originalRequest.headers.Authorization = `Bearer ${newToken}`;
            return api(originalRequest);
          }
        }
        return Promise.reject(error);
      }
    );

    return () => {
      api.interceptors.request.eject(reqInterceptor);
      api.interceptors.response.eject(resInterceptor);
    };
  }, [refreshToken]);

  useEffect(() => {
    refreshToken().finally(() => setIsLoading(false));
  }, [refreshToken]);

  const login = async (email, password) => {
    const res = await api.post('/auth/login', { email, password }, { withCredentials: true });
    setAccessToken(res.data.accessToken);
    setUser(res.data.user);
    return res.data;
  };

  const signup = async (name, email, password) => {
    const res = await api.post('/auth/signup', { name, email, password }, { withCredentials: true });
    return res.data;
  };

  const forgotPassword = async (email) => {
    const res = await api.post('/auth/forgot-password', { email });
    return res.data;
  };

  const resetPassword = async (token, password) => {
    const res = await api.post('/auth/reset-password', { token, password });
    return res.data;
  };

  const logout = async () => {
    try {
      await api.post('/auth/logout', {}, { withCredentials: true });
    } catch {
      // ignore
    }
    setUser(null);
    setAccessToken(null);
  };

  const isAuthenticated = !!user;

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated,
        isLoading,
        login,
        signup,
        logout,
        forgotPassword,
        resetPassword,
        refreshToken,
        fetchMe,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
