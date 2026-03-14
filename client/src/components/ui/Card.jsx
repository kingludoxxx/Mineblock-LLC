export default function Card({ children, className = '', ...props }) {
  return (
    <div
      className={`bg-bg-card border border-border-default rounded-xl p-5 ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
