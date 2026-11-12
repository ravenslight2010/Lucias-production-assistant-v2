import { SignIn } from '@clerk/react';
import { Factory } from 'lucide-react';
import { Link } from 'wouter';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

function Brand() {
  return (
    <span className="brand" aria-label="Lucia Production Assistant">
      <span className="brand-mark" aria-hidden="true"><Factory size={19} strokeWidth={1.7} /></span>
      <span><span className="brand-name">Lucia</span><span className="brand-sub">Production assistant</span></span>
    </span>
  );
}

export default function SignInPage() {
  return (
    <main className="clerk-page">
      <div>
        <div className="clerk-intro">
          <Link href="/" aria-label="Lucia home"><Brand /></Link>
          <h1>Welcome back</h1>
          <p>Sign in to return to your facility’s current run state.</p>
        </div>
        <div className="clerk-frame">
          <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
        </div>
      </div>
    </main>
  );
}
