import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Home from './pages/Home';
import Providers from './pages/Providers';
import ProviderDetail from './pages/ProviderDetail';
import Confirmation from './pages/Confirmation';
import Manage from './pages/Manage';
import AdminLogin from './admin/AdminLogin';
import AdminLayout from './admin/AdminLayout';
import Dashboard from './admin/Dashboard';
import AdminBookings from './admin/Bookings';
import DayView from './admin/DayView';
import AdminProviders from './admin/Providers';
import ProviderEdit from './admin/ProviderEdit';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/browse/:type" element={<Providers />} />
        <Route path="/provider/:id" element={<ProviderDetail />} />
        <Route path="/confirmation" element={<Confirmation />} />
        <Route path="/manage" element={<Manage />} />
      </Route>
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="bookings" element={<AdminBookings />} />
        <Route path="day" element={<DayView />} />
        <Route path="providers" element={<AdminProviders />} />
        <Route path="providers/:id" element={<ProviderEdit />} />
      </Route>
    </Routes>
  );
}
