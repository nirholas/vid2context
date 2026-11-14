/** The vid2context mark: the same rounded square and play triangle as the project logo. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#e8590c" />
      <path d="M12 9.5v13l10-6.5z" fill="#fff" />
    </svg>
  );
}
