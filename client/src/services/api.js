import axios from 'axios';

const api = axios.create({
  baseURL: '/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true,
});

// Auth interceptors (request token attachment + 401 refresh) are
// registered in AuthContext.jsx to avoid duplicate/conflicting handlers.

export default api;
