import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  FieldGrid,
  Input,
  MediaPlaceholder,
  ModalFooter,
  NumberField,
  Progress,
  SearchInput,
  Select,
  StepIndicator,
  SummaryCard,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from '../src/ui';

describe('ui primitives', () => {
  it('renders a loading button with disabled busy state', () => {
    const html = renderToStaticMarkup(
      <Button variant="primary" size="lg" loading loadingText="保存中">
        保存
      </Button>,
    );

    expect(html).toContain('disabled=""');
    expect(html).toContain('保存中');
  });

  it('renders Darwin button icons with local business content', () => {
    const html = renderToStaticMarkup(
      <Button
        variant="accent"
        size="sm"
        leftIcon={<span>left</span>}
        rightIcon={<span>right</span>}
      >
        生成
      </Button>,
    );

    expect(html).toContain('left');
    expect(html).toContain('right');
    expect(html).toContain('生成');
  });

  it('renders an icon-only button with an accessible label', () => {
    const html = renderToStaticMarkup(
      <Button aria-label="打开设置" variant="ghost" iconOnly>
        <span>icon</span>
      </Button>,
    );

    expect(html).toContain('aria-label="打开设置"');
    expect(html).toContain('icon');
  });

  it('renders field controls with labels and hints', () => {
    const html = renderToStaticMarkup(
      <Field label="标题" hint="最多 20 个字">
        <Input value="播客标题" readOnly />
      </Field>,
    );

    expect(html).toContain('标题');
    expect(html).toContain('最多 20 个字');
    expect(html).toContain('value="播客标题"');
  });

  it('renders a textarea field and empty state action area', () => {
    const html = renderToStaticMarkup(
      <EmptyState
        eyebrow="EMPTY"
        title="还没有内容"
        description="先导入字幕再继续"
        actions={
          <Field label="备注">
            <Textarea value="待处理" readOnly rows={2} />
          </Field>
        }
      />,
    );

    expect(html).toContain('还没有内容');
    expect(html).toContain('先导入字幕再继续');
    expect(html).toContain('textarea');
    expect(html).toContain('待处理');
  });

  it('renders badges, progress and card content', () => {
    const html = renderToStaticMarkup(
      <Card>
        <Badge variant="info">1080p</Badge>
        <Progress value={42} variant="default" />
        <Badge variant="warning">极速低码率</Badge>
      </Card>,
    );

    expect(html).toContain('1080p');
    expect(html).toContain('极速低码率');
    expect(html).toContain('aria-valuenow="42"');
  });

  it('renders media placeholders for non-visual assets', () => {
    const html = renderToStaticMarkup(
      <>
        <MediaPlaceholder variant="audio" label="AUDIO" />
        <MediaPlaceholder variant="srt" label="SRT" />
        <MediaPlaceholder variant="generic" label="PDF" />
      </>,
    );

    expect(html).toContain('AUDIO');
    expect(html).toContain('SRT');
    expect(html).toContain('PDF');
  });

  it('renders alert primitives', () => {
    const html = renderToStaticMarkup(
      <Alert variant="warning" dismissible>
        配置还不完整
      </Alert>,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('配置还不完整');
    expect(html).toContain('Dismiss alert');
  });

  it('renders divider, switch, number field and select controls', () => {
    const html = renderToStaticMarkup(
      <>
        <Divider label="高级设置" />
        <Switch label="启用关键词高亮" checked onChange={() => undefined} />
        <NumberField
          label="圆角"
          value={12}
          min={0}
          max={24}
          onChange={() => undefined}
        />
        <Field label="高亮动画">
          <Select
            value="pop"
            onChange={() => undefined}
            options={[
              { value: 'pop', label: '弹入' },
              { value: 'wipe', label: '擦入' },
            ]}
          />
        </Field>
      </>,
    );

    expect(html).toContain('高级设置');
    expect(html).toContain('启用关键词高亮');
    expect(html).toContain('圆角');
    expect(html).toContain('value="12"');
    expect(html).toContain('高亮动画');
    expect(html).toContain('弹入');
  });

  it('renders a search input, field grid and summary card', () => {
    const html = renderToStaticMarkup(
      <FieldGrid columns={2}>
        <SummaryCard title="关键词高亮样式" meta="demo.srt">
          当前有 5 处高亮
        </SummaryCard>
        <SearchInput value="关键词" readOnly placeholder="搜索文件名" />
      </FieldGrid>,
    );

    expect(html).toContain('关键词高亮样式');
    expect(html).toContain('demo.srt');
    expect(html).toContain('当前有 5 处高亮');
    expect(html).toContain('value="关键词"');
  });

  it('renders modal footer and step indicator states', () => {
    const html = renderToStaticMarkup(
      <>
        <ModalFooter
          cancelLabel="取消"
          confirmLabel="保存"
          onCancel={() => undefined}
          onConfirm={() => undefined}
        />
        <StepIndicator
          steps={[
            { label: '解析字幕', status: 'completed' },
            { label: '提炼重点', status: 'active' },
            { label: '生成卡片', status: 'pending' },
          ]}
        />
      </>,
    );

    expect(html).toContain('取消');
    expect(html).toContain('保存');
    expect(html).toContain('解析字幕');
    expect(html).toContain('提炼重点');
    expect(html).toContain('生成卡片');
  });

  it('renders default dark primitives without custom glass chrome classes', () => {
    const html = renderToStaticMarkup(
      <>
        <Button variant="secondary">默认按钮</Button>
        <Card>默认卡片</Card>
        <Input value="demo" readOnly />
        <Tabs value="assets" onValueChange={() => undefined}>
          <TabsList>
            <TabsTrigger value="assets">素材</TabsTrigger>
            <TabsTrigger value="ai">AI</TabsTrigger>
          </TabsList>
        </Tabs>
        <Dialog open onOpenChange={() => undefined}>
          <DialogContent>默认弹窗</DialogContent>
        </Dialog>
      </>,
    );

    expect(html).not.toContain('backdrop-blur');
    expect(html).not.toContain('dark:bg-zinc-900');
    expect(html).not.toContain('bg-white/80');
    expect(html).toContain('bg-mac-control');
    expect(html).toContain('bg-mac-elevated');
    expect(html).toContain('border-border');
    expect(html).toContain('border-mac-border');
  });
});
