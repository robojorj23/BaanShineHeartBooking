module.exports = {
  content: ['./booking.html', './manage.html'],
  theme: {
    extend: {
      colors: {
        ocean: {
          50: '#f0fdfa',
          100: '#ccfbf1',
          500: '#14b8a6',
          700: '#0f766e',
          800: '#115e59',
          900: '#134e4a',
        },
        sand: {
          50: '#fdfbf7',
          100: '#f7f2e7',
          200: '#ece0c8',
          500: '#d4a359',
          600: '#b88339',
        },
        deepnavy: '#0b192c',
      },
      fontFamily: {
        prompt: ['Prompt', 'sans-serif'],
        serif: ['Playfair Display', 'serif'],
      },
    },
  },
  plugins: [],
};
