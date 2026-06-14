import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import PaycheckWizardPage from './page';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/paycheck-wizard',
  useSearchParams: () => new URLSearchParams(),
}));

// Mock auth store
vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => {
      const state = {
        user: { id: 'test-user-id', email: 'test@example.com', role: 'user', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
      };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({
        user: { id: 'test-user-id', email: 'test@example.com', role: 'user', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
      }),
    }
  ),
}));

// Mock dependencies APIs
const mockGetAccounts = vi.fn();
const mockGetCategories = vi.fn();
const mockGetScheduledTransactions = vi.fn();

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAccounts(...args),
  },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: (...args: any[]) => mockGetCategories(...args),
  },
}));

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getAll: (...args: any[]) => mockGetScheduledTransactions(...args),
  },
}));

const mockAccounts = [
  { id: 'acc-1', name: 'Primary checking', accountType: 'CHEQUING', currencyCode: 'USD', isClosed: false },
];

const mockCategories = [
  { id: 'cat-taxes', name: 'Taxes', isIncome: false, parentId: null },
  { id: 'cat-fed', name: 'Federal Income', isIncome: false, parentId: 'cat-taxes' },
  { id: 'cat-state', name: 'State Income', isIncome: false, parentId: 'cat-taxes' },
  { id: 'cat-soc-sec', name: 'Social Security', isIncome: false, parentId: 'cat-taxes' },
  { id: 'cat-medicare', name: 'Medicare', isIncome: false, parentId: 'cat-taxes' },
  { id: 'cat-provincial', name: 'State/Provincial', isIncome: false, parentId: 'cat-taxes' },
];

describe('PaycheckWizardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccounts.mockResolvedValue(mockAccounts);
    mockGetCategories.mockResolvedValue(mockCategories);
    mockGetScheduledTransactions.mockResolvedValue([]);
  });

  it('renders the Paycheck Wizard and header details', async () => {
    render(<PaycheckWizardPage />);
    await waitFor(() => {
      expect(screen.getByText('Paycheck Wizard')).toBeInTheDocument();
      expect(screen.getByText('Paycheck Header Details')).toBeInTheDocument();
    });
  });

  it('pre-populates default tax items and correctly resolves their categories', async () => {
    render(<PaycheckWizardPage />);
    
    // Wait for the data loading to complete and the table to display
    await waitFor(() => {
      expect(screen.getByText('Federal Tax')).toBeInTheDocument();
    });

    // Check pre-populated tax names
    expect(screen.getByText('Federal Tax')).toBeInTheDocument();
    expect(screen.getByText('State Tax')).toBeInTheDocument();
    expect(screen.getByText('Social Security (FICA)')).toBeInTheDocument();
    expect(screen.getByText('Medicare Tax')).toBeInTheDocument();
    expect(screen.getByText('Disability (SDI)')).toBeInTheDocument();

    // Check that resolved category names are correct and mapped properly
    expect(screen.getByText('Federal Income')).toBeInTheDocument();
    expect(screen.getByText('Social Security')).toBeInTheDocument();
    expect(screen.getByText('Medicare')).toBeInTheDocument();
    expect(screen.getAllByText('State/Provincial').length).toBeGreaterThan(0); // State Tax and SDI map to State/Provincial if State Income is missing/matched
  });
});
