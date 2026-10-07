import React, { Fragment } from 'react';
import { Box, Link, Typography } from '@mui/material';

/** href 가 없으면 링크 없이 글자만 표시 */
const LINKS = [
  { label: '이용약관', href: null },
  { label: '개인정보처리방침', href: null },
  { label: '문의하기', href: null },
  { label: '카카오톡 채널', href: null },
  { label: 'PlanGo 네이버카페', href: null },
];

const textSx = { fontSize: '0.75rem', color: 'text.secondary', whiteSpace: 'nowrap' };

const FooterLink = ({ item }) => {
  const sx = {
    ...textSx,
    textDecoration: 'none',
    '&:hover': item.href ? { textDecoration: 'underline' } : undefined,
  };
  return item.href ? (
    <Link href={item.href} target="_blank" rel="noopener noreferrer" sx={sx}>
      {item.label}
    </Link>
  ) : (
    <Typography component="span" sx={sx}>
      {item.label}
    </Typography>
  );
};

const Divider = () => <Box component="span" sx={{ width: '1px', height: 10, bgcolor: 'divider' }} />;

const Footer = () => (
  <Box
    component="footer"
    sx={{
      mt: 6,
      pt: 2,
      borderTop: 1,
      borderColor: 'divider',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      flexWrap: 'wrap',
      columnGap: 1.5,
      rowGap: 0.5,
    }}
  >
    {LINKS.map((item, i) => (
      <Fragment key={item.label}>
        {i > 0 && <Divider />}
        <FooterLink item={item} />
      </Fragment>
    ))}
    <Divider />
    <Typography component="span" sx={textSx}>
      © {new Date().getFullYear()} PlanGo.Today
    </Typography>
  </Box>
);

export default Footer;
