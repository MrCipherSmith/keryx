import type { Preview } from "@storybook/react";
import { ConfigProvider } from "antd";

const preview: Preview = {
  decorators: [
    (Story) => (
      <ConfigProvider theme={{ token: { borderRadius: 4 } }}>
        <Story />
      </ConfigProvider>
    ),
  ],
};

export default preview;
