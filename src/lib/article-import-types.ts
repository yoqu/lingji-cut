// 共享契约：Renderer / Main 对齐点（微信公众号文章导入）

export interface WechatArticleMeta {
  title: string;
  account?: string;
  author?: string;
  publishTime?: string;
  digest?: string;
  coverUrl?: string;
  sourceUrl: string;
}

/** 抓取阶段结果：正文已转 Markdown，图片仍指向远程 URL，供弹窗预览与编辑 */
export interface WechatArticleFetchResult {
  articleId: string;
  meta: WechatArticleMeta;
  markdown: string;
  imageCount: number;
}

/** 落地阶段请求：项目创建后下载图片并写入 imports/wechat/<articleId>/ */
export interface WechatArticleMaterializeRequest {
  projectDir: string;
  articleId: string;
  meta: WechatArticleMeta;
  markdown: string;
}

export interface WechatArticleMaterializeResult {
  articleId: string;
  importDir: string;
  articlePath: string;
  /** 图片链接已改写为项目相对路径的最终 Markdown */
  markdown: string;
  imageCount: number;
  failedImageCount: number;
}
