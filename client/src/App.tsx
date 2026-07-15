import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Home from './pages/Home';
import Providers from './pages/Providers';
import ProviderDetail from './pages/ProviderDetail';
import Confirmation from './pages/Confirmation';
import Manage from './pages/Manage';
import Checkout from './pages/Checkout';
import Receipt from './pages/Receipt';
import Login from './customer/Login';
import Account from './customer/Account';
import AdminLogin from './admin/AdminLogin';
import AdminLayout from './admin/AdminLayout';
import Dashboard from './admin/Dashboard';
import AdminBookings from './admin/Bookings';
import DayView from './admin/DayView';
import WeekView from './admin/WeekView';
import AdminProviders from './admin/Providers';
import ProviderEdit from './admin/ProviderEdit';
import AdminReviews from './admin/Reviews';
import AdminPayments from './admin/Payments';
import AdminCoupons from './admin/Coupons';
import AdminWaitlist from './admin/Waitlist';
import AdminCustomers from './admin/Customers';
import AdminCustomerDetail from './admin/CustomerDetail';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/browse/:type" element={<Providers />} />
        <Route path="/provider/:id" element={<ProviderDetail />} />
        <Route path="/confirmation" element={<Confirmation />} />
        <Route path="/manage" element={<Manage />} />
        <Route path="/checkout/:code" element={<Checkout />} />
        <Route path="/receipt/:code" element={<Receipt />} />
        <Route path="/account/login" element={<Login />} />
        <Route path="/account" element={<Account />} />
      </Route>
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="bookings" element={<AdminBookings />} />
        <Route path="day" element={<DayView />} />
        <Route path="week" element={<WeekView />} />
        <Route path="providers" element={<AdminProviders />} />
        <Route path="providers/:id" element={<ProviderEdit />} />
        <Route path="reviews" element={<AdminReviews />} />
        <Route path="payments" element={<AdminPayments />} />
        <Route path="coupons" element={<AdminCoupons />} />
        <Route path="waitlist" element={<AdminWaitlist />} />
        <Route path="customers" element={<AdminCustomers />} />
        <Route path="customers/:id" element={<AdminCustomerDetail />} />
      </Route>
    </Routes>
  );
}
