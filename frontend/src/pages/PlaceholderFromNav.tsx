import { useLocation } from 'react-router-dom';
import { resolveNav } from '../nav/config';
import PlaceholderPage from './PlaceholderPage';

/** Renders compact placeholder using copy from `nav/config.ts` for the current path */
export default function PlaceholderFromNav() {
  const { pathname } = useLocation();
  const page = resolveNav(pathname)?.page;
  if (!page) {
    return (
      <PlaceholderPage
        title="Page"
        description="This route is not registered in the navigation configuration."
      />
    );
  }
  return (
    <PlaceholderPage
      title={page.label}
      description={page.description ?? 'Capability coming soon.'}
    />
  );
}
