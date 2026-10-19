/* 健康生活 · 云端配置模板
 *
 * 用法：把本文件复制为同目录下的 config.js，填入你自己的值。
 * config.js 已在 .gitignore 里，不会被提交。
 *
 * 不配也能用——两个页面会退化成「仅本机」，数据只存在浏览器 localStorage 里，
 * 换设备不同步，但功能完全正常。
 *
 * 后端需要具备什么、客户端要满足哪些方法，见 README 的「接自己的云同步」一节。
 */
window.HEALTH_SYNC_CONFIG = {
  // 后端地址，末尾不要带斜杠
  endpoint: 'https://your-project.example.com',

  // 允许匿名读写的公开密钥
  publishableKey: 'pk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',

  // 可选：OAuth 中转地址。后端不涉及就留空
  oauthRelayBaseUrl: '',

  // 可选：云客户端 SDK 暴露的全局变量名，默认 CloudSDK
  sdkGlobal: 'CloudSDK'
};
