import type { FormInstance } from 'antd';

/**
 * 校验表单并返回值；校验不通过时返回 null（错误已显示在各表单项下）。
 * Modal 的 onOk 里直接 await form.validateFields() 会在每次校验失败时留下一个未处理的 Promise rejection。
 */
export async function validateQuietly<T>(form: FormInstance<T>): Promise<T | null> {
  try {
    return await form.validateFields();
  } catch (err) {
    if (err && typeof err === 'object' && 'errorFields' in err) return null;
    throw err;
  }
}
