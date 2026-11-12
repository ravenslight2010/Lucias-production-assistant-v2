import { SignUp } from '@clerk/react';
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

export default function SignUpPage() {
  return (
    <main className="clerk-page">
      <div>
        <div className="clerk-intro">
          <Link href="/" aria-label="Lucia home"><Brand /></Link>
          <h1>Set up your account</h1>
          <p>Get your facility team working from one clear view.</p>
        </div>
        <div className="clerk-frame">
          <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
        </div>
      </div>
    </main>
  );
}
