import { Route, Routes } from 'react-router';
import Layout from './components/Layout';
import { Login, Register } from './pages/Auth';
import FeedPage from './pages/Feeds';
import Business from './pages/Business';
import Docs from './pages/Docs';
import Home from './pages/Home';
import Me from './pages/Me';
import { ModelDetailPage, Models } from './pages/Models';
import NotFound from './pages/NotFound';
import PostDetail from './pages/PostDetail';
import Rank from './pages/Rank';
import Search from './pages/Search';
import { StationDetailPage, Stations } from './pages/Stations';
import Submit from './pages/Submit';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="models" element={<Models />} />
        <Route path="models/:slug" element={<ModelDetailPage />} />
        <Route path="community" element={<FeedPage title="社区" kind="community" />} />
        <Route path="reviews" element={<FeedPage title="评测" kind="review" />} />
        <Route path="posts/:id" element={<PostDetail />} />
        <Route path="stations" element={<Stations />} />
        <Route path="stations/:slug" element={<StationDetailPage />} />
        <Route path="rank" element={<Rank />} />
        <Route path="search" element={<Search />} />
        <Route path="submit" element={<Submit />} />
        <Route path="me" element={<Me />} />
        <Route path="login" element={<Login />} />
        <Route path="register" element={<Register />} />
        <Route path="docs" element={<Docs />} />
        <Route path="business" element={<Business />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
