import { InputHTMLAttributes, useState } from 'react';

interface PasswordFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
}

/** Password input with a show/hide toggle so users can verify what they typed before submitting. */
export function PasswordField({ label, id, ...inputProps }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const inputId = id ?? 'password';

  return (
    <div>
      <label htmlFor={inputId}>{label}</label>
      <div className="password-field">
        <input id={inputId} type={visible ? 'text' : 'password'} {...inputProps} />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          tabIndex={-1}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  );
}
