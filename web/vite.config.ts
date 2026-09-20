import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 开发时把接口代理到后台 API，Cookie 同源
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: false } },
  },
  build: {
    // 样式按较旧的移动端浏览器输出：默认目标会把 @media (max-width: …) 压成范围语法 (width<=…)，
    // iOS 16.3 及更早的 Safari 不认识，整段手机样式会被忽略
    cssTarget: ['chrome87', 'safari14', 'firefox78', 'edge88'],
    // 最大的块是按需加载的 ECharts（约 510 kB，只有带图表的页面才下载）；其余超过这个数就该拆了
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        // 体积大、更新频率低的第三方库单独成块：页面代码变更后浏览器仍可复用这些缓存。
        // antd 故意不单独成块：交给打包器按路由自动拆分，登录页 / 外壳只下载用得到的组件（整包 antd 超过 1 MB）。
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/, priority: 30 },
            { name: 'echarts', test: /node_modules[\\/](echarts|zrender)[\\/]/, priority: 20 },
          ],
        },
      },
    },
  },
});
