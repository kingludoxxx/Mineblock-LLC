import { useState } from 'react';
import { Link } from 'react-router-dom';
import Input from '../../components/ui/Input';
import Button from '../../components/ui/Button';

export default function ResetPasswordPage() {
  const [form, setForm] = useState({ password: '', confirmPassword: '' });

  const handleSubmit = (e) => {
    e.preventDefault();
    // TODO: implement
  };

  return (
    <div className="min-h-screen bg-bg-main flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-xl font-semibold text-text-primary">Set new password</h1>
          <p className="text-sm text-text-muted mt-1">Enter your new password below</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input label="New password" type="password" placeholder="Min 8 characters" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <Input label="Confirm password" type="password" placeholder="Repeat password" value={form.confirmPassword} onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })} />
          <Button type="submit" className="w-full">Update password</Button>
        </form>
        <p className="text-sm text-text-muted text-center mt-6">
          <Link to="/login" className="text-accent hover:underline">Back to login</Link>
        </p>
      </div>
    </div>
  );
}
